/**
 * The Lua↔native bridge: turns loaded accelerator modules into the `fw.native`
 * table a Lua game calls. A game declares native `.fwmod` helpers in its
 * manifest; the BIOS loads each into an AcceleratorRuntime (wasm32 or Xtensa)
 * and hands the runtimes here, keyed by name.
 *
 * Lua sees `fw.native.<mod>` with the module's exports as direct callables and
 * an `alloc(n)` that returns a buffer — a window into the module's own memory
 * (a bare shared pointer on real hardware). Passing a buffer to an export
 * marshals it to its guest pointer, so the same Lua code runs in the emulator
 * and on silicon:
 *
 *   local fx = fw.native.helpers
 *   local buf = fx.alloc(64)
 *   fx.shade(buf, 8, 8, t)        -- C fills the buffer
 *   local s = fx.sum(buf, 64)     -- C reduces it
 *   local v = buf.get(0)          -- read a byte back
 */
import type { AcceleratorRuntime } from "../exec/module-runtime.js";

/** A Lua-facing native buffer. Marshals to its guest pointer when passed to an
 *  export; `get`/`set` read/write single bytes, `bytes()` copies the lot out. */
export interface NativeBuffer {
  readonly ptr: number;
  readonly length: number;
  get(index: unknown): number;
  set(index: unknown, value: unknown): void;
  bytes(): number[];
}

const asInt = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? n : 0;
};

function makeBuffer(
  rt: AcceleratorRuntime,
  ptr: number,
  length: number,
): NativeBuffer {
  return {
    ptr,
    length,
    get(index: unknown): number {
      const i = asInt(index);
      if (i < 0 || i >= length) return 0;
      return rt.read(ptr + i, 1)[0] ?? 0;
    },
    set(index: unknown, value: unknown): void {
      const i = asInt(index);
      if (i < 0 || i >= length) return;
      rt.write(ptr + i, Uint8Array.of(asInt(value) & 0xff));
    },
    bytes(): number[] {
      return [...rt.read(ptr, length)];
    },
  };
}

/** True for a value that carries a guest pointer (a NativeBuffer or a copy of
 *  one that survived a Lua round-trip). */
function hasPtr(v: unknown): v is { ptr: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { ptr?: unknown }).ptr === "number"
  );
}

/** Marshal a Lua call arg to an int32: a buffer → its guest pointer, else a
 *  number. (Floats-as-bits and multi-buffer structs are a later concern.) */
const marshal = (a: unknown): number => (hasPtr(a) ? a.ptr : asInt(a));

const RESERVED = new Set(["alloc", "call", "exports"]);

function makeHandle(rt: AcceleratorRuntime): Record<string, unknown> {
  const handle: Record<string, unknown> = {
    /** Reserve `nbytes` of shared scratch in the module; returns a buffer. */
    alloc: (nbytes: unknown): NativeBuffer => {
      const n = Math.max(0, asInt(nbytes));
      return makeBuffer(rt, rt.alloc(n), n);
    },
    /** Escape hatch: call an export by name (e.g. one shadowed by alloc/call). */
    call: (name: unknown, ...args: unknown[]): number =>
      rt.callExport(String(name), args.map(marshal)),
    exports: [...rt.exports],
  };
  // Expose each export as a direct callable (unless its name is reserved).
  for (const name of rt.exports) {
    if (RESERVED.has(name)) continue;
    handle[name] = (...args: unknown[]): number =>
      rt.callExport(name, args.map(marshal));
  }
  return handle;
}

/**
 * Build the `fw.native` table from a name→runtime map. Each key is a module the
 * game declared; the value is its handle (exports + alloc). An empty map yields
 * an empty table — a game with no native helpers just never indexes it.
 */
export function buildNativeApi(
  accelerators: Record<string, AcceleratorRuntime>,
): Record<string, unknown> {
  const native: Record<string, unknown> = {};
  for (const [name, rt] of Object.entries(accelerators)) {
    native[name] = makeHandle(rt);
  }
  return native;
}
