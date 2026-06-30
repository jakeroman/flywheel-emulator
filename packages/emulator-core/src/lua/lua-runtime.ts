import { LuaFactory, type LuaEngine } from "wasmoon";
import type { FlywheelDevice } from "../hal/device.js";
import { Graphics } from "../gfx/graphics.js";
import { createFlywheelApi } from "./flywheel-api.js";

export type LuaStatus = "idle" | "running" | "error";

export interface LuaRuntimeCallbacks {
  /** Lua `print(...)` and `fw.log(...)` output. */
  onLog?: (message: string) => void;
  /** A load-time or per-frame Lua error. The runtime stops on error. */
  onError?: (error: Error) => void;
  /** Status transitions (idle → running → error). */
  onStatus?: (status: LuaStatus) => void;
}

export interface LuaRuntimeOptions {
  /**
   * Explicit URL for wasmoon's `glue.wasm`. Required in the browser to keep the
   * app self-contained — without it wasmoon fetches the wasm from a public CDN.
   * The web layer supplies this via a bundler asset URL. Omit in Node, where
   * wasmoon resolves the wasm from the filesystem.
   */
  wasmUri?: string;
}

type LuaFn = (...args: unknown[]) => unknown;

/**
 * Runs a Flywheel Lua app against the device. A script defines optional
 * `_init()`, `_update(dt)`, and `_draw()` globals; the host run loop polls the
 * gamepad, then calls update() and draw() each frame. All drawing, input,
 * storage, and audio go through the injected `fw` API, which calls the HAL —
 * so the runtime never touches a canvas or the DOM and is testable in Node.
 */
export class LuaRuntime {
  private engine: LuaEngine | null = null;
  private readonly gfx: Graphics;
  private _status: LuaStatus = "idle";
  private timeMs = 0;
  /** Monotonic load counter; bumped to cancel any in-flight load(). */
  private loadSeq = 0;

  private updateFn: LuaFn | null = null;
  private drawFn: LuaFn | null = null;

  constructor(
    private readonly device: FlywheelDevice,
    private readonly callbacks: LuaRuntimeCallbacks = {},
    private readonly options: LuaRuntimeOptions = {},
  ) {
    this.gfx = new Graphics(device.display);
  }

  get status(): LuaStatus {
    return this._status;
  }

  /**
   * Load and start a script, replacing any current one. Re-entrant-safe: a
   * newer load() (or dispose()) supersedes an in-flight one, and the superseded
   * engine is closed rather than leaked or left running.
   */
  async load(source: string): Promise<boolean> {
    const seq = ++this.loadSeq;
    this.updateFn = null;
    this.drawFn = null;
    this.closeEngine();
    if (seq !== this.loadSeq) return false; // superseded during teardown
    this.timeMs = 0;

    // Fail loud rather than letting wasmoon silently reach for a public CDN.
    if (!this.options.wasmUri && typeof window !== "undefined") {
      this.fail(new Error("LuaRuntime: wasmUri is required in the browser"));
      return false;
    }

    const factory = new LuaFactory(this.options.wasmUri);
    let engine: LuaEngine;
    try {
      engine = await factory.createEngine({ injectObjects: true });
    } catch (error) {
      if (seq === this.loadSeq) this.fail(error);
      return false;
    }
    if (seq !== this.loadSeq) {
      closeQuietly(engine);
      return false;
    }
    this.engine = engine;

    const api = createFlywheelApi({
      device: this.device,
      gfx: this.gfx,
      getTimeMs: () => this.timeMs,
      log: (message) => this.callbacks.onLog?.(message),
    });
    engine.global.set("fw", api);
    engine.global.set("print", (...args: unknown[]) =>
      this.callbacks.onLog?.(args.map((a) => stringify(a)).join("\t")),
    );

    try {
      await engine.doString(source);
      if (seq !== this.loadSeq) return false; // superseded during doString
      this.updateFn = asFn(engine.global.get("_update"));
      this.drawFn = asFn(engine.global.get("_draw"));
      this.setStatus("running");
      // Start each app on a clean framebuffer so switching scripts doesn't
      // leave the previous one's frozen frame on the bistable display.
      this.gfx.clear();
      asFn(engine.global.get("_init"))?.();
      return this._status === "running";
    } catch (error) {
      if (seq === this.loadSeq) this.fail(error);
      return false;
    }
  }

  /** Advance the script by dtSeconds (calls Lua `_update`). */
  update(dtSeconds: number): void {
    if (this._status !== "running") return;
    this.timeMs += dtSeconds * 1000;
    if (!this.updateFn) return;
    try {
      this.updateFn(dtSeconds);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Render a frame (calls Lua `_draw`). */
  draw(): void {
    if (this._status !== "running") return;
    if (!this.drawFn) return;
    try {
      this.drawFn();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stop and tear down the engine, cancelling any in-flight load(). */
  async dispose(): Promise<void> {
    this.loadSeq++; // cancel any in-flight load
    this.updateFn = null;
    this.drawFn = null;
    this.closeEngine();
    if (this._status !== "idle") this.setStatus("idle");
  }

  private closeEngine(): void {
    if (this.engine) {
      closeQuietly(this.engine);
      this.engine = null;
    }
  }

  private fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.setStatus("error");
    this.callbacks.onError?.(err);
  }

  private setStatus(status: LuaStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.callbacks.onStatus?.(status);
  }
}

function closeQuietly(engine: LuaEngine): void {
  try {
    engine.global.close();
  } catch {
    // Engine already closed — ignore.
  }
}

function asFn(value: unknown): LuaFn | null {
  return typeof value === "function" ? (value as LuaFn) : null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
