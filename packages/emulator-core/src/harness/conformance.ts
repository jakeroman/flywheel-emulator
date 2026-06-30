/**
 * Deterministic conformance driver for the faithfulness harness.
 *
 * Replays a scripted sequence of input + time steps through any frame-driven
 * runtime (Lua or a native module), recording the HAL effect trace. The same
 * script + module must produce the same trace on every run and on every
 * backend — that reproducibility is what "runnable" gets to mean, and what lets
 * a future Xtensa backend be validated differentially against wasm32.
 *
 * Determinism rules enforced by construction: time advances ONLY by the
 * script's dt (the runtime's clock is driven from update(dt), never wall time),
 * one poll→update→draw→snapshot per frame, mirroring the real run loop.
 */

import type { Button, GamepadDevice } from "../hal/gamepad.js";
import type { DisplayDevice } from "../hal/display.js";
import type { ModuleRuntime } from "../exec/module-runtime.js";
import type { HalEffectRecorder, HalEvent } from "./effect-trace.js";

/** Edge-driving gamepad surface (the emulated Gamepad, beyond the HAL's poll). */
interface DrivableGamepad extends GamepadDevice {
  press(button: Button): void;
  release(button: Button): void;
}

interface ConformanceDevice {
  readonly display: DisplayDevice;
  readonly gamepad: DrivableGamepad;
}

export interface InputFrame {
  /** Milliseconds this frame advances (default 16 ≈ 60fps). */
  dtMs?: number;
  /** Buttons to press before this frame's poll. */
  press?: Button[];
  /** Buttons to release before this frame's poll. */
  release?: Button[];
}

export interface InputScript {
  frames: InputFrame[];
}

export interface ConformanceResult {
  events: HalEvent[];
  finalStatus: ModuleRuntime["status"];
  /** Number of frames driven before the runtime left "running" (or the count). */
  framesRun: number;
}

const DEFAULT_DT_MS = 16;

/**
 * Drive `runtime` through `script`, recording into `recorder`. The recorder
 * should already be attached to the device's SD / audio / log before calling.
 * Stops early (still returns) if the runtime drops out of "running".
 */
export function runConformance(
  device: ConformanceDevice,
  runtime: ModuleRuntime,
  script: InputScript,
  recorder: HalEffectRecorder,
): ConformanceResult {
  let framesRun = 0;
  for (const frame of script.frames) {
    if (runtime.status !== "running") break;
    for (const b of frame.press ?? []) device.gamepad.press(b);
    for (const b of frame.release ?? []) device.gamepad.release(b);
    device.gamepad.poll();
    runtime.update((frame.dtMs ?? DEFAULT_DT_MS) / 1000);
    runtime.draw();
    recorder.frame(device.display);
    framesRun++;
  }
  return { events: recorder.events, finalStatus: runtime.status, framesRun };
}
