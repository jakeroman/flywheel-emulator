import type { LuaEngine } from "wasmoon";
import type { FlywheelDevice } from "../hal/device.js";
import { Graphics } from "../gfx/graphics.js";
import type { AcceleratorRuntime } from "../exec/module-runtime.js";
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
  /**
   * Per-call wall-clock budget (ms) for a Lua callback. wasmoon installs an
   * instruction-count hook that throws if a single _init/_update/_draw runs
   * longer than this, so a runaway loop (e.g. `while true do end`) becomes a
   * catchable error instead of hanging the main thread. Caught by update()/
   * draw() → fail(), flipping status to "error" so the BIOS can recover.
   */
  functionTimeoutMs?: number;
  /**
   * Real monotonic wall-clock in ms, backing `fw.clock()` (profiling). Defaults
   * to performance.now()/Date.now(); override in tests for a deterministic clock.
   */
  now?: () => number;
}

const DEFAULT_FUNCTION_TIMEOUT_MS = 500;

/**
 * Installs a per-game `require` that resolves modules to sibling `.lua` files on
 * the SD (the v1 package.searchers model), sandboxed to the game directory. It
 * calls back into the host `__fw_load_module(name)` to read the source, caches
 * the module result, and errors if the file isn't found — it never reaches the
 * host filesystem. Runs before the game's own source.
 */
const REQUIRE_BOOTSTRAP = `do
  local cache = {}
  function require(name)
    if cache[name] ~= nil then return cache[name] end
    local src = __fw_load_module(name)
    if src == nil then error("module not found: " .. tostring(name), 2) end
    local chunk, err = load(src, "@" .. tostring(name))
    if not chunk then error(err, 2) end
    local result = chunk()
    if result == nil then result = true end
    cache[name] = result
    return result
  end
end`;

/**
 * Main-loop mode support. A game may own its control flow like v1 — a top-level
 * `while true do ... fw.flip() end` loop — instead of defining _update/_draw.
 * This wraps the injected JS `fw` in a Lua table that adds the yielding
 * primitives (which must be Lua, since only Lua can coroutine.yield): fw.flip()
 * yields the game's coroutine back to the host (which presents the frame, polls
 * input, and resumes next frame); fw.gfx.refresh() presents AND yields; fw.wait
 * / sleep() yield across frames; fw.dt() is the last frame delta. The wrapper
 * reads through to the JS `fw` via a function __index so we never mutate the
 * proxy. In callback mode these are no-ops (isyieldable() is false off-coroutine).
 *
 * On hardware this maps to a frame-paced task on the APP core: flip() == push the
 * framebuffer over SPI, then vTaskDelayUntil(next frame) — present, pace, yield.
 */
const MAIN_BOOTSTRAP = `do
  local js = fw
  local yield = coroutine.yield
  local yieldable = coroutine.isyieldable

  local function flip()
    if yieldable() then yield() end
  end

  local gfx = setmetatable({
    refresh = function()
      local r = js.gfx.refresh
      if r then r() end
      flip()
    end,
  }, { __index = function(_, k) return js.gfx[k] end })

  local function wait(sec)
    if not yieldable() then return end
    sec = sec or 0
    local t = 0
    repeat
      yield()
      t = t + (__fw_dt() or 0)
    until t >= sec
  end

  fw = setmetatable(
    { flip = flip, wait = wait, gfx = gfx, dt = __fw_dt },
    { __index = function(_, k) return js[k] end }
  )
  function sleep(ms) fw.wait((ms or 0) / 1000) end
end`;

/**
 * Runs the user chunk inside a coroutine so a top-level loop can yield (fw.flip)
 * instead of blocking. If the first resume yields, the game owns the loop
 * ("main" mode) and the host resumes it each frame via __fw_step(); if it
 * returns, the game uses callbacks ("callback" mode) and the host reads
 * _update/_draw. __fw_source is set from the host before this runs.
 */
const DRIVER = `local chunk, err = load(__fw_source, "@main")
if not chunk then error(err, 0) end
__fw_co = coroutine.create(chunk)
local ok, e = coroutine.resume(__fw_co)
if not ok then error(e, 0) end
__fw_mode = coroutine.status(__fw_co) == "suspended" and "main" or "callback"
function __fw_step()
  if coroutine.status(__fw_co) ~= "suspended" then return "dead" end
  local sok, serr = coroutine.resume(__fw_co)
  if not sok then error(serr, 0) end
  return coroutine.status(__fw_co)
end`;

type LuaFn = (...args: unknown[]) => unknown;

/**
 * Runs a Flywheel Lua app against the device, in either of two execution models:
 *
 *  - Callback mode: the script defines `_init()`, `_update(dt)`, `_draw()`; the
 *    host run loop polls the gamepad, then calls update() + draw() each frame.
 *  - Main-loop mode (v1-style): the script owns control flow with a top-level
 *    `while true do ... fw.flip() end` loop. It runs as a coroutine that yields
 *    each frame; the host resumes it once per frame. Auto-detected at load — if
 *    the chunk yields, it's main mode; if it returns, it's callback mode.
 *
 * All drawing, input, storage, and audio go through the injected `fw` API, which
 * calls the HAL — so the runtime never touches a canvas or the DOM and is
 * testable in Node.
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

  // Main-loop mode: the game's coroutine stepper, the last frame delta it reads
  // via fw.dt(), and whether its loop has run to completion.
  private mainMode = false;
  private stepFn: LuaFn | null = null;
  private lastDt = 0;
  private finished = false;

  // System-button state a game can drive: whether it captured the Menu button
  // (fw.custom_menu_button) and whether it asked to return to the launcher
  // (fw.exit). Both are read by the BIOS and reset on every load().
  private menuCaptured = false;
  private exitReq = false;

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

  /** Whether the current game took over the Menu button via
   *  `fw.custom_menu_button(true)`. See ModuleRuntime.capturesMenu. */
  get capturesMenu(): boolean {
    return this.menuCaptured;
  }

  /** Whether the current game called `fw.exit()` to return to the launcher.
   *  The BIOS polls this after update(). See ModuleRuntime.exitRequested. */
  get exitRequested(): boolean {
    return this.exitReq;
  }

  /**
   * Load and start a script, replacing any current one. Re-entrant-safe: a
   * newer load() (or dispose()) supersedes an in-flight one, and the superseded
   * engine is closed rather than leaked or left running.
   */
  async load(
    source: string,
    native: Record<string, AcceleratorRuntime> = {},
    saveDir?: string,
    scriptDir?: string,
  ): Promise<boolean> {
    const seq = ++this.loadSeq;
    this.updateFn = null;
    this.drawFn = null;
    this.mainMode = false;
    this.stepFn = null;
    this.finished = false;
    this.lastDt = 0;
    // A fresh game reverts the system-button defaults: Menu is the BIOS home
    // button again, and no exit is pending.
    this.menuCaptured = false;
    this.exitReq = false;
    this.closeEngine();
    if (seq !== this.loadSeq) return false; // superseded during teardown
    this.timeMs = 0;

    // Fail loud rather than letting wasmoon silently reach for a public CDN.
    if (!this.options.wasmUri && typeof window !== "undefined") {
      this.fail(new Error("LuaRuntime: wasmUri is required in the browser"));
      return false;
    }

    // Import wasmoon lazily so its (large) glue isn't in the eager bundle — the
    // device shell and BIOS load without it; the VM fetches on first launch.
    const { LuaFactory } = await import("wasmoon");
    const factory = new LuaFactory(this.options.wasmUri);
    let engine: LuaEngine;
    try {
      engine = await factory.createEngine({
        injectObjects: true,
        functionTimeout:
          this.options.functionTimeoutMs ?? DEFAULT_FUNCTION_TIMEOUT_MS,
      });
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
      now: this.options.now,
      log: (message) => this.callbacks.onLog?.(message),
      native,
      saveDir,
      // fw.custom_menu_button() flips who owns the Menu button; fw.exit() asks
      // the BIOS to return to the launcher. Both write flags the BIOS reads.
      setMenuCapture: (on) => {
        this.menuCaptured = on;
      },
      requestExit: () => {
        this.exitReq = true;
      },
    });
    engine.global.set("fw", api);
    engine.global.set("print", (...args: unknown[]) =>
      this.callbacks.onLog?.(args.map((a) => stringify(a)).join("\t")),
    );
    // Per-game `require`: resolve modules to sibling .lua files on the SD.
    engine.global.set("__fw_load_module", this.moduleLoader(scriptDir));
    // fw.dt() in main-loop mode reads the last frame delta the host stepped with.
    engine.global.set("__fw_dt", () => this.lastDt);

    try {
      await engine.doString(REQUIRE_BOOTSTRAP);
      if (seq !== this.loadSeq) return false;
      await engine.doString(MAIN_BOOTSTRAP);
      if (seq !== this.loadSeq) return false;
      this.setStatus("running");
      // Start each app on a clean framebuffer so switching scripts doesn't
      // leave the previous one's frozen frame on the bistable display. (In main
      // mode the game draws its first frame during the driver's initial resume.)
      this.gfx.clear();
      // Run the user chunk in a coroutine and detect which model it uses.
      engine.global.set("__fw_source", source);
      await engine.doString(DRIVER);
      if (seq !== this.loadSeq) return false; // superseded during doString
      if (engine.global.get("__fw_mode") === "main") {
        this.mainMode = true;
        this.stepFn = asFn(engine.global.get("__fw_step"));
      } else {
        this.updateFn = asFn(engine.global.get("_update"));
        this.drawFn = asFn(engine.global.get("_draw"));
        asFn(engine.global.get("_init"))?.();
      }
      return this._status === "running";
    } catch (error) {
      if (seq === this.loadSeq) this.fail(error);
      return false;
    }
  }

  /**
   * Advance one frame. In callback mode this calls Lua `_update`; in main-loop
   * mode it resumes the game's coroutine to its next frame yield (fw.flip).
   */
  update(dtSeconds: number): void {
    if (this._status !== "running") return;
    this.timeMs += dtSeconds * 1000;
    if (this.mainMode) {
      if (!this.stepFn || this.finished) return;
      this.lastDt = dtSeconds;
      try {
        // Resume to the next yield; "dead" means the loop ran to completion.
        if (this.stepFn() === "dead") this.finished = true;
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    if (!this.updateFn) return;
    try {
      this.updateFn(dtSeconds);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Render a frame (calls Lua `_draw`). Main-loop games draw inside their own
   *  loop before each flip, so there is nothing to do here for them. */
  draw(): void {
    if (this._status !== "running") return;
    if (this.mainMode || !this.drawFn) return;
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
    this.mainMode = false;
    this.stepFn = null;
    this.finished = false;
    this.menuCaptured = false;
    this.exitReq = false;
    this.closeEngine();
    if (this._status !== "idle") this.setStatus("idle");
  }

  /**
   * The host side of `require`: map a module name to a sibling `.lua` file's
   * source under the game's script dir, or undefined if there's no dir or the
   * name is unsafe/missing. `.lua` is appended if absent; the name is a
   * "/"-separated path that may not be absolute or contain ".." (no escaping
   * the game dir).
   */
  private moduleLoader(
    scriptDir: string | undefined,
  ): (name: unknown) => string | undefined {
    return (rawName: unknown): string | undefined => {
      if (!scriptDir) return undefined;
      let rel = String(rawName ?? "");
      if (!rel.toLowerCase().endsWith(".lua")) rel += ".lua";
      if (rel === "" || rel.startsWith("/") || rel.includes("\\")) {
        return undefined;
      }
      const parts = rel.split("/");
      for (const p of parts) {
        if (p === "" || p === "." || p === "..") return undefined;
      }
      const path = `${scriptDir}/${parts.join("/")}`;
      try {
        if (this.device.sd.existsSync(path)) {
          return this.device.sd.readTextFileSync(path);
        }
      } catch {
        /* unreadable → treat as not found */
      }
      return undefined;
    };
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
