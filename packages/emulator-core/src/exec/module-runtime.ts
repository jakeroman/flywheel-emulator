/**
 * The frame-driven execution contract.
 *
 * A program (a Lua script, or — Phase 5 — a native .fwmod module) is loaded,
 * then driven one frame at a time against the HAL: poll input, update(dt),
 * draw(). LuaRuntime and the wasm32 module backend both expose this shape so the
 * BIOS run loop and the conformance harness can drive either without caring how
 * the program executes underneath.
 *
 * `load()` is intentionally NOT part of this interface: its input differs by
 * backend (a Lua source string vs. raw .fwmod bytes), so each backend types its
 * own. This interface is the shared *run-loop* surface only.
 */

export type RuntimeStatus = "idle" | "running" | "error";

export interface ModuleRuntimeCallbacks {
  /** Diagnostic output: Lua `print`/`fw.log`, or a native module's `log`. */
  onLog?: (message: string) => void;
  /** A load-time or per-frame error. The runtime stops on error. */
  onError?: (error: Error) => void;
  /** Status transitions (idle → running → error). */
  onStatus?: (status: RuntimeStatus) => void;
}

export interface ModuleRuntime {
  readonly status: RuntimeStatus;
  /** Advance one frame (dt in seconds). No-op unless status is "running". */
  update(dtSeconds: number): void;
  /** Render one frame. No-op unless status is "running". */
  draw(): void;
  /** Release all resources; safe to call more than once. */
  dispose(): void | Promise<void>;
  /**
   * Whether the running program has taken over the Menu button. Default (and
   * absent → false): the BIOS treats Menu as the system/home button and a press
   * returns to the launcher. A program that opts in (Lua's
   * `fw.custom_menu_button(true)`) receives Menu like any other button instead.
   * Only meaningful while `status === "running"`; the BIOS ignores a dead
   * program's claim so a crashed game can always be Menu'd out of.
   */
  readonly capturesMenu?: boolean;
  /**
   * Set when the program asked to return to the launcher (Lua's `fw.exit()`).
   * The BIOS polls this after update() and performs a canonical restart. A flag
   * rather than a direct call so the request is honored *after* the frame
   * returns — never tearing down the engine from inside its own callback.
   */
  readonly exitRequested?: boolean;
}

/**
 * A native backend (wasm32 / Xtensa) that also exposes the module's accelerator
 * exports — named C functions a Lua game calls for hot-path work, plus a way to
 * hand them buffers. `alloc` reserves host-owned scratch *inside the module's own
 * memory* and returns a guest pointer; the module reads/writes it directly, and
 * the host reads it back with `read`. On real hardware that pointer is bare RAM
 * shared by Lua and the module; in the emulator it's a window into the wasm
 * linear memory / Xtensa arena — the same Lua code works against both.
 */
export interface AcceleratorRuntime extends ModuleRuntime {
  /** Names of the module's exported accelerator functions (may be empty). */
  readonly exports: readonly string[];
  /** Reserve `nbytes` of zeroed scratch in the module's memory; returns a guest
   *  pointer. Throws if the module's scratch region is exhausted. */
  alloc(nbytes: number): number;
  /** Copy `len` bytes out of the module's memory at a guest pointer. */
  read(ptr: number, len: number): Uint8Array;
  /** Copy `bytes` into the module's memory at a guest pointer. */
  write(ptr: number, bytes: Uint8Array): void;
  /** Call an export by name with up to four int32 args (padded with 0); returns
   *  its int32 result. Throws if the name isn't exported. */
  callExport(name: string, args?: readonly number[]): number;
}

/** Whether a runtime exposes the accelerator (export/buffer) surface. */
export function isAccelerator(rt: ModuleRuntime): rt is AcceleratorRuntime {
  return "callExport" in rt && typeof (rt as AcceleratorRuntime).alloc === "function";
}
