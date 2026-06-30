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
}
