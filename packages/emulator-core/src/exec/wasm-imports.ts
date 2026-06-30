/**
 * The `env` import object a wasm32 native module is instantiated with — the
 * runtime side of the module ABI (tools/fwmod/include/fw_api.h).
 *
 * In the native (Xtensa/host) world the host hands the module a struct of
 * function pointers; in wasm that same surface is a set of imports the module
 * calls. Each function mirrors a fw_api_t member, marshalling i32 pointer
 * arguments through the module's linear memory and dispatching to the SAME HAL
 * (via Graphics + the device) that the Lua `fw` API uses — so one C source and
 * a Lua app drive identical device behavior. Bools cross as i32 (nonzero=true);
 * unlike Lua, wasm args are already finite integers, so no coercion is needed.
 */

import type { FlywheelDevice } from "../hal/device.js";
import { Button } from "../hal/gamepad.js";
import type { Graphics } from "../gfx/graphics.js";
import { readBytes, readCString, writeBytes } from "./wasm-memory.js";

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

/** int button id (fw_button_t order) → Button; Menu is reserved (not exposed). */
const BUTTON_BY_ID: ReadonlyArray<Button> = [
  Button.Up,
  Button.Down,
  Button.Left,
  Button.Right,
  Button.A,
  Button.B,
  Button.Select,
];

/** Build the `env` import functions. Memory is NOT included — the module
 *  exports its own linear memory, which the runtime reads after instantiation. */
export function createWasmEnv(
  ctx: WasmEnvContext,
): Record<string, WebAssembly.ImportValue> {
  const { device, gfx } = ctx;
  const str = (ptr: number): string => readCString(ctx.memory, ptr);
  const on = (v: number): boolean => v !== 0;
  const button = (id: number): Button | null => BUTTON_BY_ID[id] ?? null;

  return {
    // ---- input ----
    btn: (id: number): number => {
      const b = button(id);
      return b && device.gamepad.isDown(b) ? 1 : 0;
    },
    btnp: (id: number): number => {
      const b = button(id);
      return b && device.gamepad.wasPressed(b) ? 1 : 0;
    },

    // ---- graphics ----
    cls: (v: number): void => gfx.clear(on(v)),
    pixel: (x: number, y: number, v: number): void => gfx.pixel(x, y, on(v)),
    line: (x0: number, y0: number, x1: number, y1: number, v: number): void =>
      gfx.line(x0, y0, x1, y1, on(v)),
    rect: (x: number, y: number, w: number, h: number, v: number): void =>
      gfx.rect(x, y, w, h, on(v)),
    rectfill: (x: number, y: number, w: number, h: number, v: number): void =>
      gfx.rectFill(x, y, w, h, on(v)),
    circle: (x: number, y: number, r: number, v: number): void =>
      gfx.circle(x, y, r, on(v)),
    circfill: (x: number, y: number, r: number, v: number): void =>
      gfx.circleFill(x, y, r, on(v)),
    print: (sPtr: number, x: number, y: number, v: number): void => {
      gfx.print(str(sPtr), x, y, on(v)); // gfx.print returns a cursor; discard it
    },
    text_width: (sPtr: number): number => gfx.textWidth(str(sPtr)),

    // ---- filesystem (resident SD, synchronous) ----
    fs_read: (pathPtr: number, bufPtr: number, cap: number): number => {
      try {
        const data = device.sd.readFileSync(str(pathPtr));
        return writeBytes(ctx.memory, bufPtr, data, cap);
      } catch {
        return -1;
      }
    },
    fs_write: (pathPtr: number, dataPtr: number, len: number): number => {
      try {
        device.sd.writeFileSync(str(pathPtr), readBytes(ctx.memory, dataPtr, len));
        return 0;
      } catch {
        return -1;
      }
    },
    fs_exists: (pathPtr: number): number =>
      device.sd.existsSync(str(pathPtr)) ? 1 : 0,

    // ---- sound ----
    tone: (hz: number, ms: number): void => device.audio.playTone(hz, ms),

    // ---- misc ----
    time_ms: (): number => Math.floor(ctx.getTimeMs()) >>> 0,
    log: (msgPtr: number): void => ctx.log(str(msgPtr)),
  };
}
