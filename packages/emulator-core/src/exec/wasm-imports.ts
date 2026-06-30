/**
 * The `env` import object a wasm32 native module is instantiated with — the
 * runtime side of the module ABI (tools/fwmod/include/fw_api.h).
 *
 * Each import maps a wasm function-call signature onto the SHARED fw_api
 * operations (hal-ops.ts), which the Xtensa backend also uses — so there is one
 * HAL surface, not two. The wasm side just adapts its i32 params to the op.
 */

import type { FlywheelDevice } from "../hal/device.js";
import type { Graphics } from "../gfx/graphics.js";
import { HAL_OPS, type HalContext } from "./hal-ops.js";
import { WasmMem } from "./mem-access.js";

export interface WasmEnvContext {
  /** The module's exported linear memory. `memory` is NOT an import; the runtime
   *  points this at `instance.exports.memory` right after instantiation (before
   *  any import is callable), so the marshalling functions read the real memory. */
  memory: WebAssembly.Memory;
  device: FlywheelDevice;
  gfx: Graphics;
  getTimeMs: () => number;
  log: (message: string) => void;
}

/** Build the `env` import functions. Memory is NOT included — the module
 *  exports its own linear memory, which the runtime reads after instantiation. */
export function createWasmEnv(
  ctx: WasmEnvContext,
): Record<string, WebAssembly.ImportValue> {
  // A WasmMem reads ctx.memory lazily, so it tracks the exported memory the
  // runtime assigns after instantiation (and any later growth/detach).
  const hal: HalContext = {
    mem: new WasmMem(() => ctx.memory),
    device: ctx.device,
    gfx: ctx.gfx,
    getTimeMs: ctx.getTimeMs,
    log: ctx.log,
  };

  return {
    btn: (id: number): number => HAL_OPS.btn(hal, id),
    btnp: (id: number): number => HAL_OPS.btnp(hal, id),
    cls: (v: number): void => HAL_OPS.cls(hal, v),
    pixel: (x: number, y: number, v: number): void => HAL_OPS.pixel(hal, x, y, v),
    line: (x0: number, y0: number, x1: number, y1: number, v: number): void =>
      HAL_OPS.line(hal, x0, y0, x1, y1, v),
    rect: (x: number, y: number, w: number, h: number, v: number): void =>
      HAL_OPS.rect(hal, x, y, w, h, v),
    rectfill: (x: number, y: number, w: number, h: number, v: number): void =>
      HAL_OPS.rectfill(hal, x, y, w, h, v),
    circle: (x: number, y: number, r: number, v: number): void =>
      HAL_OPS.circle(hal, x, y, r, v),
    circfill: (x: number, y: number, r: number, v: number): void =>
      HAL_OPS.circfill(hal, x, y, r, v),
    print: (sPtr: number, x: number, y: number, v: number): void =>
      HAL_OPS.print(hal, sPtr, x, y, v),
    text_width: (sPtr: number): number => HAL_OPS.text_width(hal, sPtr),
    fs_read: (pathPtr: number, bufPtr: number, cap: number): number =>
      HAL_OPS.fs_read(hal, pathPtr, bufPtr, cap),
    fs_write: (pathPtr: number, dataPtr: number, len: number): number =>
      HAL_OPS.fs_write(hal, pathPtr, dataPtr, len),
    fs_exists: (pathPtr: number): number => HAL_OPS.fs_exists(hal, pathPtr),
    tone: (hz: number, ms: number): void => HAL_OPS.tone(hal, hz, ms),
    time_ms: (): number => HAL_OPS.time_ms(hal),
    log: (msgPtr: number): void => HAL_OPS.log(hal, msgPtr),
  };
}
