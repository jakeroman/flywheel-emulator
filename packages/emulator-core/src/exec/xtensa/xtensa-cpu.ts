/**
 * Xtensa LX7 (call0) execution core.
 *
 * Executes the decoded call0 subset against a flat RAM "arena" (a Uint8Array
 * mapped at a guest base address — the module's payload, bss, stack, and the
 * fw_api jump-table struct all live here). No register windows (call0): just
 * a0..a15, PC, and SAR.
 *
 * Host calls fall out naturally: the fw_api jump-table slots hold sentinel
 * addresses OUTSIDE the arena, so a CALLX0 to one sets PC outside the arena and
 * the run loop hands it to the runtime's handler (which dispatches to the HAL
 * and resumes at the return address). A reserved HOST_RETURN sentinel is how a
 * top-level call (fw_main/init/update/draw) returns control to the host.
 *
 * Little-endian throughout. Loads/stores and instruction fetch are bounds-
 * checked against the arena; an out-of-range data access throws (an illegal
 * access trap the runtime turns into status "error").
 */

import { decodeXtensa } from "./xtensa-decode.js";

/** What the out-of-arena handler decides when PC leaves the arena. */
export type OutOfArena = "stop" | "continue";

export class XtensaCpu {
  /** a0..a15 (call0 ABI: a0=return addr, a1=sp, a2-a7=args/return). */
  readonly ar = new Int32Array(16);
  pc = 0;
  sar = 0;

  private readonly view: DataView;

  constructor(
    readonly arena: Uint8Array,
    readonly base: number,
  ) {
    this.view = new DataView(arena.buffer, arena.byteOffset, arena.byteLength);
  }

  // ---- memory (guest address → arena index, bounds-checked) ----

  private at(addr: number, size: number): number {
    const i = (addr >>> 0) - this.base;
    if (i < 0 || i + size > this.arena.length) {
      throw new Error(
        `xtensa: out-of-bounds memory access at 0x${(addr >>> 0).toString(16)}`,
      );
    }
    return i;
  }
  load32 = (addr: number): number => this.view.getInt32(this.at(addr, 4), true);
  load16u = (addr: number): number => this.view.getUint16(this.at(addr, 2), true);
  load8u = (addr: number): number => this.view.getUint8(this.at(addr, 1));
  store32 = (addr: number, v: number): void =>
    this.view.setInt32(this.at(addr, 4), v | 0, true);
  store16 = (addr: number, v: number): void =>
    this.view.setUint16(this.at(addr, 2), v & 0xffff, true);
  store8 = (addr: number, v: number): void =>
    this.view.setUint8(this.at(addr, 1), v & 0xff);

  private inArena(addr: number): boolean {
    const i = (addr >>> 0) - this.base;
    return i >= 0 && i < this.arena.length;
  }

  /**
   * Run until PC leaves the arena (the handler decides stop vs. continue) or the
   * instruction budget is exhausted (throws — the runaway-loop backstop the wasm
   * backend lacks). The handler, on a host-call sentinel, dispatches the call and
   * sets PC back to the return address, then returns "continue".
   */
  run(handleOutOfArena: (addr: number) => OutOfArena, budget = 2_000_000): void {
    for (let n = 0; n < budget; n++) {
      if (!this.inArena(this.pc)) {
        if (handleOutOfArena(this.pc) === "stop") return;
        continue;
      }
      this.stepOne();
    }
    throw new Error(`xtensa: instruction budget (${budget}) exceeded`);
  }

  /** Decode + execute one instruction at PC, advancing PC. */
  stepOne(): void {
    const ar = this.ar;
    const i = decodeXtensa(this.arena, (this.pc >>> 0) - this.base, this.pc >>> 0);
    switch (i.mnemonic) {
      // ---- arithmetic / logical (dest = r) ----
      case "add":
        ar[i.r] = ar[i.s] + ar[i.t];
        break;
      case "sub":
        ar[i.r] = ar[i.s] - ar[i.t];
        break;
      case "and":
        ar[i.r] = ar[i.s] & ar[i.t];
        break;
      case "or":
        ar[i.r] = ar[i.s] | ar[i.t];
        break;
      case "xor":
        ar[i.r] = ar[i.s] ^ ar[i.t];
        break;
      case "neg":
        ar[i.r] = -ar[i.t];
        break;
      case "abs":
        ar[i.r] = Math.abs(ar[i.t]) | 0;
        break;
      case "add.n":
        ar[i.r] = ar[i.s] + ar[i.t];
        break;
      case "addi.n":
        ar[i.r] = ar[i.s] + i.imm;
        break;
      // ---- immediate (dest = t) ----
      case "addi":
      case "addmi":
        ar[i.t] = ar[i.s] + i.imm;
        break;
      case "movi":
        ar[i.t] = i.imm;
        break;
      case "movi.n":
        ar[i.s] = i.imm;
        break;
      case "mov.n":
        ar[i.s] = ar[i.t];
        break;
      // ---- loads / stores ----
      case "l8ui":
        ar[i.t] = this.load8u((ar[i.s] + i.imm) >>> 0);
        break;
      case "l16ui":
        ar[i.t] = this.load16u((ar[i.s] + i.imm) >>> 0);
        break;
      case "l32i":
      case "l32i.n":
        ar[i.t] = this.load32((ar[i.s] + i.imm) >>> 0);
        break;
      case "s8i":
        this.store8((ar[i.s] + i.imm) >>> 0, ar[i.t]);
        break;
      case "s16i":
        this.store16((ar[i.s] + i.imm) >>> 0, ar[i.t]);
        break;
      case "s32i":
      case "s32i.n":
        this.store32((ar[i.s] + i.imm) >>> 0, ar[i.t]);
        break;
      case "l32r":
        ar[i.t] = this.load32(i.target);
        break;
      // ---- control flow (set PC explicitly, skip the default advance) ----
      case "call0":
        ar[0] = (this.pc + 3) >>> 0;
        this.pc = i.target >>> 0;
        return;
      case "callx0":
        ar[0] = (this.pc + 3) >>> 0;
        this.pc = ar[i.s] >>> 0;
        return;
      case "ret":
      case "jx":
        this.pc = ar[i.s] >>> 0;
        return;
      case "ret.n":
        this.pc = ar[0] >>> 0;
        return;
      case "j":
        this.pc = i.target >>> 0;
        return;
      case "beqz.n":
        if (ar[i.s] === 0) {
          this.pc = i.target >>> 0;
          return;
        }
        break;
      case "bnez.n":
        if (ar[i.s] !== 0) {
          this.pc = i.target >>> 0;
          return;
        }
        break;
      // ---- no-ops ----
      case "nop":
      case "nop.n":
      case "memw":
        break;
      default:
        throw new Error(
          `xtensa: unsupported instruction "${i.mnemonic}" (0x${i.word.toString(16)}) at pc 0x${(this.pc >>> 0).toString(16)}`,
        );
    }
    this.pc = (this.pc + i.length) >>> 0;
  }
}
