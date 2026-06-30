/**
 * The wasm32 native-module execution backend (Phase 5).
 *
 * Loads a `.fwmod` whose payload is a WebAssembly module, instantiates it with
 * the HAL-backed `env` imports, and drives its fw_main → {init,update,draw}
 * lifecycle each frame — the native-module analog of LuaRuntime, satisfying the
 * same ModuleRuntime contract so the BIOS run loop and the conformance harness
 * drive it identically.
 *
 * ABI (see tools/fwmod/examples/hello-wasm.wat): the module exports `memory`,
 * an `__indirect_function_table`, and `fw_main(api)->i32`. fw_main returns a
 * pointer to a fw_module_t = three consecutive i32 table indices {init, update,
 * draw}; 0 means init failed. Host fw_api calls are wasm imports from `env`.
 *
 * Sandbox note: wasm has no wasmoon-style functionTimeout, so a runaway
 * update/draw can still hang the thread (the same exposure Lua had pre-Worker).
 * True termination needs the deferred Web Worker isolation; bounded as
 * best-effort until then.
 */

import type { FlywheelDevice } from "../hal/device.js";
import { Graphics } from "../gfx/graphics.js";
import { Arch, decodeFwmod, type FwModule } from "../fwmod/index.js";
import type {
  ModuleRuntime,
  ModuleRuntimeCallbacks,
  RuntimeStatus,
} from "./module-runtime.js";
import { createWasmEnv, type WasmEnvContext } from "./wasm-imports.js";

type WasmFn = (...args: number[]) => number | void;

const MODULE_STRUCT_BYTES = 12; // three i32: init, update, draw

export class WasmModuleRuntime implements ModuleRuntime {
  private readonly gfx: Graphics;
  private _status: RuntimeStatus = "idle";
  private timeMs = 0;
  /** Monotonic load counter; bumped to cancel an in-flight or superseded load. */
  private loadSeq = 0;

  // Holding the table funcrefs (updateFn/drawFn) keeps the instance and its
  // import closures alive for the module's lifetime; no separate handle needed.
  private updateFn: WasmFn | null = null;
  private drawFn: WasmFn | null = null;

  constructor(
    private readonly device: FlywheelDevice,
    private readonly callbacks: ModuleRuntimeCallbacks = {},
  ) {
    this.gfx = new Graphics(device.display);
  }

  get status(): RuntimeStatus {
    return this._status;
  }

  /**
   * Load and start a wasm32 `.fwmod` (raw container bytes). Re-entrant-safe: a
   * newer load() or dispose() supersedes an in-flight one. Returns true if the
   * module is running afterward.
   */
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
    if (module.arch !== Arch.Wasm32) {
      this.fail(
        new Error(`WasmModuleRuntime cannot run arch "${module.archLabel}"`),
      );
      return false;
    }

    try {
      // Copy into a fresh ArrayBuffer-backed view (the payload is a subarray of
      // the .fwmod buffer; the copy also gives a clean BufferSource type).
      const compiled = await WebAssembly.compile(new Uint8Array(module.payload));
      if (seq !== this.loadSeq) return false; // superseded during compile

      // env reads ctx.memory lazily; we point it at the instance's exported
      // memory right after instantiation (before any import is ever called).
      const ctx: WasmEnvContext = {
        // Throwaway: overwritten with the module's exported memory below, before
        // any import (which reads ctx.memory lazily) can run.
        memory: new WebAssembly.Memory({ initial: 1 }),
        device: this.device,
        gfx: this.gfx,
        getTimeMs: () => this.timeMs,
        log: (m) => this.callbacks.onLog?.(m),
      };
      const instance = await WebAssembly.instantiate(compiled, {
        env: createWasmEnv(ctx),
      });
      if (seq !== this.loadSeq) return false; // superseded during instantiate

      const ex = instance.exports;
      const memory = ex.memory;
      const table = ex.__indirect_function_table;
      const fwMain = ex.fw_main;
      if (!(memory instanceof WebAssembly.Memory)) {
        throw new Error("module does not export 'memory'");
      }
      if (!(table instanceof WebAssembly.Table)) {
        throw new Error("module does not export '__indirect_function_table'");
      }
      if (typeof fwMain !== "function") {
        throw new Error("module does not export a 'fw_main' function");
      }
      ctx.memory = memory;

      const ptr = ((fwMain as WasmFn)(0) as number) >>> 0; // i32 pointer, unsigned
      if (!ptr) throw new Error("fw_main returned NULL (module init failed)");
      if (ptr + MODULE_STRUCT_BYTES > memory.buffer.byteLength) {
        throw new Error("fw_main returned an out-of-bounds module pointer");
      }
      const view = new DataView(memory.buffer);
      const initFn = tableFn(table, view.getUint32(ptr, true));
      this.updateFn = tableFn(table, view.getUint32(ptr + 4, true));
      this.drawFn = tableFn(table, view.getUint32(ptr + 8, true));

      this.setStatus("running");
      // Start on a clean framebuffer (parity with LuaRuntime).
      this.gfx.clear();
      initFn?.();
      return this._status === "running";
    } catch (e) {
      if (seq === this.loadSeq) this.fail(e);
      return false;
    }
  }

  update(dtSeconds: number): void {
    if (this._status !== "running") return;
    this.timeMs += dtSeconds * 1000;
    if (!this.updateFn) return;
    try {
      this.updateFn(dtSeconds);
    } catch (e) {
      this.fail(e);
    }
  }

  draw(): void {
    if (this._status !== "running" || !this.drawFn) return;
    try {
      this.drawFn();
    } catch (e) {
      this.fail(e);
    }
  }

  dispose(): void {
    this.loadSeq++;
    this.teardown();
    if (this._status !== "idle") this.setStatus("idle");
  }

  private teardown(): void {
    this.updateFn = null;
    this.drawFn = null;
    // Route through setStatus so observers (e.g. the BIOS onStatus) see idle,
    // matching LuaRuntime; setStatus no-ops when the status is unchanged.
    if (this._status === "running") this.setStatus("idle");
  }

  private setStatus(status: RuntimeStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.callbacks.onStatus?.(status);
  }

  private fail(error: unknown): void {
    this.updateFn = null;
    this.drawFn = null;
    this.setStatus("error");
    this.callbacks.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

function tableFn(table: WebAssembly.Table, index: number): WasmFn | null {
  if (index < 0 || index >= table.length) return null;
  const fn = table.get(index);
  return typeof fn === "function" ? (fn as WasmFn) : null;
}
