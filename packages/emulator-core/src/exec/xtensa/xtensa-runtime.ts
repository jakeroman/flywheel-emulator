/**
 * The Xtensa LX7 (call0) native-module execution backend — the hardware-faithful
 * sibling of WasmModuleRuntime, satisfying the same ModuleRuntime contract.
 *
 * It lays the module's flat payload into a RAM arena at the linked base
 * (load_addr, e.g. 0x3FC88000), zero-fills bss, builds a real fw_api_t jump-table
 * struct (3 data words + 17 function-pointer words holding SENTINEL addresses
 * outside the arena), and gives the module a descending stack. It then calls
 * fw_main(api) — reading back the fw_module_t (three guest code addresses) — and
 * drives init/update/draw each frame on the XtensaCpu. A CALLX0 to a sentinel
 * lands the PC outside the arena; the run loop's handler maps it to the matching
 * HAL op (the SAME hal-ops surface the wasm backend uses), reading args from
 * a2.. per the call0 ABI, and resumes at the return address.
 *
 * NOTE: validated against hand-assembled call0 programs; running real
 * xtensa-esp32s3-elf -Os output end-to-end needs a gcc>=10 (call0-capable)
 * toolchain. Ships behind the loader's runnable gate.
 */

import type { FlywheelDevice } from "../../hal/device.js";
import { Graphics } from "../../gfx/graphics.js";
import { Arch, decodeFwmod, type FwModule } from "../../fwmod/index.js";
import type {
  AcceleratorRuntime,
  ModuleRuntimeCallbacks,
  RuntimeStatus,
} from "../module-runtime.js";
import { ArenaMem } from "../mem-access.js";
import { readBytesAt, readCStringAt, writeBytesAt } from "../wasm-memory.js";
import { callHalOp, HAL_OP_NAMES, type HalContext } from "../hal-ops.js";
import { XtensaCpu, type OutOfArena } from "./xtensa-cpu.js";

const SENTINEL_BASE = 0x3ff00000; // host fn-pointer sentinels (outside any arena)
const HOST_RETURN = 0x3ffffffc; // a top-level call returns here
const HEAP_BYTES = 0x20000; // 128 KiB of host-allocated accelerator scratch
const STACK_BYTES = 0x4000; // 16 KiB descending call0 stack
const STRUCT_BYTES = 12 + HAL_OP_NAMES.length * 4; // 3 data words + fn ptrs
const MAX_EXPORTS = 256; // cap when walking the exports array
const BUDGET = 2_000_000;

const align16 = (n: number): number => (n + 15) & ~15;

const f32Bits = (x: number): number => {
  const f = new Float32Array(1);
  f[0] = x;
  return new Int32Array(f.buffer)[0];
};

export class XtensaModuleRuntime implements AcceleratorRuntime {
  private readonly gfx: Graphics;
  private _status: RuntimeStatus = "idle";
  private timeMs = 0;
  private loadSeq = 0;

  private cpu: XtensaCpu | null = null;
  private handler: ((addr: number) => OutOfArena) | null = null;
  private sp = 0;
  private fns: { init: number; update: number; draw: number } | null = null;

  // Accelerator surface: the arena + its guest base, a name→code-address export
  // map, and a bump allocator over the arena's heap region (below the stack).
  private arena: Uint8Array | null = null;
  private base = 0;
  private exportMap = new Map<string, number>();
  private heapPtr = 0;
  private heapEnd = 0;

  constructor(
    private readonly device: FlywheelDevice,
    private readonly callbacks: ModuleRuntimeCallbacks = {},
  ) {
    this.gfx = new Graphics(device.display);
  }

  get status(): RuntimeStatus {
    return this._status;
  }

  /** Load a call0 xtensa-lx7 .fwmod, set up the arena + jump table, run fw_main,
   *  and start. Async only for parity with the other backends. */
  async load(fwmodBytes: Uint8Array): Promise<boolean> {
    const seq = ++this.loadSeq;
    this.teardown();
    this.timeMs = 0;

    let module: FwModule;
    try {
      module = decodeFwmod(fwmodBytes);
    } catch (e) {
      this.fail(e);
      return false;
    }
    const problems = module.validate();
    if (problems.length > 0) {
      this.fail(new Error(`invalid .fwmod: ${problems[0]}`));
      return false;
    }
    if (module.arch !== Arch.XtensaLx7) {
      this.fail(
        new Error(`XtensaModuleRuntime cannot run arch "${module.archLabel}"`),
      );
      return false;
    }

    try {
      const base = module.loadAddr >>> 0;
      const apiOff = align16(module.codeSize + module.bssSize);
      // Layout: payload | api struct | heap (host scratch, grows up) | stack
      // (grows down from the top). Heap and stack share the headroom.
      const heapBase = align16(apiOff + STRUCT_BYTES);
      const arena = new Uint8Array(heapBase + HEAP_BYTES + STACK_BYTES);
      arena.set(module.payload, 0);

      // The arena must sit entirely below the host sentinel region (and not wrap
      // past 2^32), or a real arena address could be mistaken for a host call.
      const arenaEnd = (base + arena.length) >>> 0;
      if (arenaEnd <= base || arenaEnd > SENTINEL_BASE) {
        throw new Error(
          `xtensa: arena [0x${base.toString(16)}..0x${arenaEnd.toString(16)}) overlaps the host sentinel region at 0x${SENTINEL_BASE.toString(16)}`,
        );
      }

      const view = new DataView(arena.buffer);
      // fw_api_t: abi_version, width, height, then one sentinel per fn-ptr slot.
      view.setUint32(apiOff, 1, true);
      view.setInt32(apiOff + 4, this.gfx.width, true);
      view.setInt32(apiOff + 8, this.gfx.height, true);
      for (let i = 0; i < HAL_OP_NAMES.length; i++) {
        view.setUint32(apiOff + 12 + i * 4, (SENTINEL_BASE + i * 4) >>> 0, true);
      }
      const apiAddr = (base + apiOff) >>> 0;
      this.sp = (base + arena.length - 16) & ~15;
      this.arena = arena;
      this.base = base;
      this.heapPtr = (base + heapBase) >>> 0;
      this.heapEnd = (base + heapBase + HEAP_BYTES) >>> 0;

      const cpu = new XtensaCpu(arena, base);
      const hal: HalContext = {
        mem: new ArenaMem(arena, base),
        device: this.device,
        gfx: this.gfx,
        getTimeMs: () => this.timeMs,
        log: (m) => this.callbacks.onLog?.(m),
      };
      const handler = (addr: number): OutOfArena => {
        const a = addr >>> 0;
        if (a === HOST_RETURN) return "stop";
        const slot = (a - SENTINEL_BASE) >> 2;
        if (a >= SENTINEL_BASE && slot < HAL_OP_NAMES.length && (a & 3) === 0) {
          const r = callHalOp(HAL_OP_NAMES[slot], hal, [
            cpu.ar[2],
            cpu.ar[3],
            cpu.ar[4],
            cpu.ar[5],
            cpu.ar[6],
            cpu.ar[7],
          ]);
          if (typeof r === "number") cpu.ar[2] = r | 0;
          cpu.pc = cpu.ar[0] >>> 0; // return to caller
          return "continue";
        }
        throw new Error(`xtensa: jump to unmapped address 0x${a.toString(16)}`);
      };
      this.cpu = cpu;
      this.handler = handler;

      // fw_main(api) → guest pointer to fw_module_t {init, update, draw, exports}.
      const modPtr = this.callFn((base + module.entryOffset) >>> 0, [apiAddr]) >>> 0;
      if (seq !== this.loadSeq) return false;
      if (modPtr === 0) throw new Error("fw_main returned NULL (init failed)");
      this.fns = {
        init: cpu.load32(modPtr) >>> 0,
        update: cpu.load32(modPtr + 4) >>> 0,
        draw: cpu.load32(modPtr + 8) >>> 0,
      };
      this.exportMap = this.readExports(cpu, cpu.load32(modPtr + 12) >>> 0);

      this.setStatus("running");
      this.gfx.clear();
      this.callFn(this.fns.init, []);
      return this._status === "running";
    } catch (e) {
      if (seq === this.loadSeq) this.fail(e);
      return false;
    }
  }

  update(dtSeconds: number): void {
    if (this._status !== "running" || !this.fns) return;
    this.timeMs += dtSeconds * 1000;
    try {
      // call0 soft-float: a float arg passes in a2 as its raw IEEE-754 bits.
      this.callFn(this.fns.update, [f32Bits(dtSeconds)]);
    } catch (e) {
      this.fail(e);
    }
  }

  draw(): void {
    if (this._status !== "running" || !this.fns) return;
    try {
      this.callFn(this.fns.draw, []);
    } catch (e) {
      this.fail(e);
    }
  }

  // ---- accelerator surface (AcceleratorRuntime) ----

  get exports(): readonly string[] {
    return [...this.exportMap.keys()];
  }

  alloc(nbytes: number): number {
    const n = (Math.max(0, nbytes | 0) + 15) & ~15;
    const ptr = this.heapPtr >>> 0;
    if (ptr + n > this.heapEnd) {
      throw new Error("xtensa: accelerator scratch exhausted");
    }
    this.heapPtr = (ptr + n) >>> 0;
    return ptr;
  }

  read(ptr: number, len: number): Uint8Array {
    if (!this.arena) return new Uint8Array(0);
    return readBytesAt(this.arena, (ptr >>> 0) - this.base, len);
  }

  write(ptr: number, bytes: Uint8Array): void {
    if (this.arena) {
      writeBytesAt(this.arena, (ptr >>> 0) - this.base, bytes, bytes.length);
    }
  }

  callExport(name: string, args: readonly number[] = []): number {
    const addr = this.exportMap.get(name);
    if (addr === undefined) throw new Error(`xtensa: no export "${name}"`);
    if (this._status !== "running") throw new Error("xtensa: module not running");
    return this.callFn(addr, args);
  }

  dispose(): void {
    this.loadSeq++;
    this.teardown();
    if (this._status !== "idle") this.setStatus("idle");
  }

  /** Enter a top-level guest function (fw_main/init/update/draw or an export)
   *  with up to four args in a2..a5 (call0), a fresh stack, and a0 = HOST_RETURN;
   *  run to the host-return. Returns a2. */
  private callFn(addr: number, args: readonly number[]): number {
    const cpu = this.cpu;
    const handler = this.handler;
    if (!cpu || !handler) throw new Error("xtensa: no module loaded");
    cpu.ar[0] = HOST_RETURN | 0;
    cpu.ar[1] = this.sp;
    cpu.ar[2] = (args[0] ?? 0) | 0;
    cpu.ar[3] = (args[1] ?? 0) | 0;
    cpu.ar[4] = (args[2] ?? 0) | 0;
    cpu.ar[5] = (args[3] ?? 0) | 0;
    cpu.pc = addr >>> 0;
    cpu.run(handler, BUDGET);
    return cpu.ar[2];
  }

  /** Walk a {name_ptr, fn_addr}[] array (NUL-name terminated) into a name→address
   *  map, tolerating an absent/out-of-arena pointer. */
  private readExports(cpu: XtensaCpu, arrPtr: number): Map<string, number> {
    const map = new Map<string, number>();
    if (!arrPtr) return map;
    let p = arrPtr >>> 0;
    for (let i = 0; i < MAX_EXPORTS; i++) {
      let namePtr: number;
      let fnAddr: number;
      try {
        namePtr = cpu.load32(p) >>> 0;
        fnAddr = cpu.load32(p + 4) >>> 0;
      } catch {
        break; // walked off the arena
      }
      if (namePtr === 0) break; // {NULL,NULL} terminator
      const name = this.arena ? readCStringAt(this.arena, namePtr - this.base) : "";
      if (name) map.set(name, fnAddr);
      p = (p + 8) >>> 0;
    }
    return map;
  }

  private teardown(): void {
    this.cpu = null;
    this.handler = null;
    this.fns = null;
    this.arena = null;
    this.exportMap = new Map();
    this.heapPtr = 0;
    this.heapEnd = 0;
    if (this._status === "running") this.setStatus("idle");
  }

  private setStatus(status: RuntimeStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.callbacks.onStatus?.(status);
  }

  private fail(error: unknown): void {
    this.fns = null;
    this.setStatus("error");
    this.callbacks.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
