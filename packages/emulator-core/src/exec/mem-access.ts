/**
 * A uniform view of a guest's memory for the shared HAL dispatch, so one set of
 * fw_api operations (hal-ops.ts) serves both backends:
 *   - WasmMem wraps a wasm module's (growable) linear memory; pointers are
 *     offsets from 0.
 *   - ArenaMem wraps the Xtensa interpreter's RAM arena; guest pointers are
 *     absolute addresses (e.g. 0x3FC88xxx) translated to an arena index.
 */

import { readBytesAt, readCStringAt, writeBytesAt } from "./wasm-memory.js";

export interface MemAccess {
  /** Read a NUL-terminated UTF-8 string at a guest pointer. */
  readCString(ptr: number, maxLen?: number): string;
  /** Read up to `len` bytes at a guest pointer (a copy). */
  readBytes(ptr: number, len: number): Uint8Array;
  /** Write up to `cap` bytes at a guest pointer; returns the count written. */
  writeBytes(ptr: number, data: Uint8Array, cap: number): number;
}

/** Linear memory of a wasm module. The getter is re-evaluated each call because
 *  growing the memory detaches the previous ArrayBuffer. Offset 0 = null. */
export class WasmMem implements MemAccess {
  constructor(private readonly getMemory: () => WebAssembly.Memory) {}
  private bytes(): Uint8Array {
    return new Uint8Array(this.getMemory().buffer);
  }
  readCString(ptr: number, maxLen?: number): string {
    if ((ptr >>> 0) === 0) return "";
    return readCStringAt(this.bytes(), ptr, maxLen);
  }
  readBytes(ptr: number, len: number): Uint8Array {
    return readBytesAt(this.bytes(), ptr, len);
  }
  writeBytes(ptr: number, data: Uint8Array, cap: number): number {
    return writeBytesAt(this.bytes(), ptr, data, cap);
  }
}

/** The Xtensa RAM arena. Guest addresses are absolute; an address below `base`
 *  or past the arena translates to an out-of-range index and reads empty / 0
 *  (never out of bounds). Guest address 0 is treated as a null pointer. */
export class ArenaMem implements MemAccess {
  constructor(
    private readonly arena: Uint8Array,
    private readonly base: number,
  ) {}
  private index(ptr: number): number {
    // (ptr - base) as unsigned; an underflow wraps high and fails the bounds
    // check inside the *At helpers.
    return ((ptr >>> 0) - this.base) >>> 0;
  }
  readCString(ptr: number, maxLen?: number): string {
    if ((ptr >>> 0) === 0) return "";
    return readCStringAt(this.arena, this.index(ptr), maxLen);
  }
  readBytes(ptr: number, len: number): Uint8Array {
    return readBytesAt(this.arena, this.index(ptr), len);
  }
  writeBytes(ptr: number, data: Uint8Array, cap: number): number {
    return writeBytesAt(this.arena, this.index(ptr), data, cap);
  }
}
