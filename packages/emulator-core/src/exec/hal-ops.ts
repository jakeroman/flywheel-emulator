/**
 * The shared fw_api → HAL operations.
 *
 * Both native backends call host services through the same surface; only HOW
 * arguments arrive differs (wasm function params vs. Xtensa registers). Each op
 * here takes resolved numeric args + a context (a MemAccess for pointer/string
 * args, plus the device/graphics/hooks) and performs the HAL effect — so the
 * wasm import object and the Xtensa sentinel-trap dispatch share one definition
 * and cannot drift. The surface mirrors the Lua `fw` API and fw_api.h field
 * order (see HAL_OP_NAMES). Bools cross as i32 (nonzero = true).
 */

import type { FlywheelDevice } from "../hal/device.js";
import { Button } from "../hal/gamepad.js";
import type { Graphics } from "../gfx/graphics.js";
import type { MemAccess } from "./mem-access.js";

export interface HalContext {
  mem: MemAccess;
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

const on = (v: number): boolean => v !== 0;
const button = (id: number): Button | null => BUTTON_BY_ID[id] ?? null;

/** The fw_api operations, keyed by name. Pointer args are guest addresses
 *  resolved through ctx.mem. Each returns an i32 result (or void). */
export const HAL_OPS = {
  btn: (c: HalContext, id: number): number => {
    const b = button(id);
    return b && c.device.gamepad.isDown(b) ? 1 : 0;
  },
  btnp: (c: HalContext, id: number): number => {
    const b = button(id);
    return b && c.device.gamepad.wasPressed(b) ? 1 : 0;
  },
  cls: (c: HalContext, v: number): void => c.gfx.clear(on(v)),
  pixel: (c: HalContext, x: number, y: number, v: number): void =>
    c.gfx.pixel(x, y, on(v)),
  line: (c: HalContext, x0: number, y0: number, x1: number, y1: number, v: number): void =>
    c.gfx.line(x0, y0, x1, y1, on(v)),
  rect: (c: HalContext, x: number, y: number, w: number, h: number, v: number): void =>
    c.gfx.rect(x, y, w, h, on(v)),
  rectfill: (c: HalContext, x: number, y: number, w: number, h: number, v: number): void =>
    c.gfx.rectFill(x, y, w, h, on(v)),
  circle: (c: HalContext, x: number, y: number, r: number, v: number): void =>
    c.gfx.circle(x, y, r, on(v)),
  circfill: (c: HalContext, x: number, y: number, r: number, v: number): void =>
    c.gfx.circleFill(x, y, r, on(v)),
  print: (c: HalContext, sPtr: number, x: number, y: number, v: number): void => {
    c.gfx.print(c.mem.readCString(sPtr), x, y, on(v)); // gfx.print returns a cursor; discard
  },
  text_width: (c: HalContext, sPtr: number): number =>
    c.gfx.textWidth(c.mem.readCString(sPtr)),
  fs_read: (c: HalContext, pathPtr: number, bufPtr: number, cap: number): number => {
    try {
      return c.mem.writeBytes(
        bufPtr,
        c.device.sd.readFileSync(c.mem.readCString(pathPtr)),
        cap,
      );
    } catch {
      return -1;
    }
  },
  fs_write: (c: HalContext, pathPtr: number, dataPtr: number, len: number): number => {
    try {
      c.device.sd.writeFileSync(
        c.mem.readCString(pathPtr),
        c.mem.readBytes(dataPtr, len),
      );
      return 0;
    } catch {
      return -1;
    }
  },
  fs_exists: (c: HalContext, pathPtr: number): number =>
    c.device.sd.existsSync(c.mem.readCString(pathPtr)) ? 1 : 0,
  tone: (c: HalContext, hz: number, ms: number): void => c.device.audio.playTone(hz, ms),
  time_ms: (c: HalContext): number => Math.floor(c.getTimeMs()) >>> 0,
  log: (c: HalContext, msgPtr: number): void => c.log(c.mem.readCString(msgPtr)),
};

export type HalOpName = keyof typeof HAL_OPS;

/** Invoke a HAL op by name with positional args (extra args are ignored by each
 *  op). The single place the op-union variadic call is type-erased. */
export function callHalOp(
  name: HalOpName,
  ctx: HalContext,
  args: number[],
): number | void {
  return (HAL_OPS[name] as (c: HalContext, ...a: number[]) => number | void)(
    ctx,
    ...args,
  );
}

/** fw_api_t function-pointer slot order (must match fw_api.h). The Xtensa bridge
 *  maps each jump-table slot index to the op of the same name. */
export const HAL_OP_NAMES: ReadonlyArray<HalOpName> = [
  "btn",
  "btnp",
  "cls",
  "pixel",
  "line",
  "rect",
  "rectfill",
  "circle",
  "circfill",
  "print",
  "text_width",
  "fs_read",
  "fs_write",
  "fs_exists",
  "tone",
  "time_ms",
  "log",
];
