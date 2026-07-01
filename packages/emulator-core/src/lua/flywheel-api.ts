import type { FlywheelDevice } from "../hal/device.js";
import { ALL_BUTTONS, Button } from "../hal/gamepad.js";
import type { Graphics } from "../gfx/graphics.js";
import type { AcceleratorRuntime } from "../exec/module-runtime.js";
import { buildNativeApi } from "./native-bridge.js";

/**
 * Builds the `fw` table injected into the Lua environment — the Flywheel Lua
 * API. This is the contract Lua apps are written against, so it is kept small,
 * stable, and forgiving of argument types (Lua numbers arrive as JS numbers;
 * optional booleans default sensibly).
 *
 * Layout:
 *   fw.width / fw.height           display size
 *   fw.UP/DOWN/LEFT/RIGHT/A/B/SELECT   button ids (Menu is reserved by the
 *                                      BIOS as the system/home button)
 *   fw.btn(id) / fw.btnp(id)       held / pressed-this-frame
 *   fw.gfx.{cls,pixel,line,rect,rectfill,circle,circfill,print,text_width}
 *   fw.fs.{read,write,exists,list,mkdir,remove,stat}   resident SD (sync)
 *   fw.sound.tone(hz, ms)
 *   fw.time()                      seconds since the script loaded
 *   fw.log(...)                    write to the dev console
 */
export interface FlywheelApiContext {
  device: FlywheelDevice;
  gfx: Graphics;
  getTimeMs: () => number;
  log: (message: string) => void;
  /** Loaded native accelerator modules exposed as `fw.native.<name>` (the
   *  game's declared C helpers). Omit for a game with none. */
  native?: Record<string, AcceleratorRuntime>;
}

const BUTTON_SET: ReadonlySet<string> = new Set(ALL_BUTTONS);

export function createFlywheelApi(
  ctx: FlywheelApiContext,
): Record<string, unknown> {
  const { device, gfx } = ctx;

  // Menu is reserved by the BIOS as the system/home button; games never see it.
  const toButton = (v: unknown): Button | null =>
    typeof v === "string" && BUTTON_SET.has(v) && v !== Button.Menu
      ? (v as Button)
      : null;
  const onFlag = (v: unknown, dflt = true): boolean =>
    v === undefined || v === null ? dflt : Boolean(v);
  // Coerce to a finite number; NaN/Infinity → 0 so they can't reach the
  // Bresenham/circle loops (where Infinity would never terminate).
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  return {
    width: gfx.width,
    height: gfx.height,

    UP: Button.Up,
    DOWN: Button.Down,
    LEFT: Button.Left,
    RIGHT: Button.Right,
    A: Button.A,
    B: Button.B,
    SELECT: Button.Select,

    btn: (id: unknown): boolean => {
      const b = toButton(id);
      return b ? device.gamepad.isDown(b) : false;
    },
    btnp: (id: unknown): boolean => {
      const b = toButton(id);
      return b ? device.gamepad.wasPressed(b) : false;
    },

    gfx: {
      width: gfx.width,
      height: gfx.height,
      cls: (on?: unknown) => gfx.clear(onFlag(on, false)),
      pixel: (x: unknown, y: unknown, on?: unknown) =>
        gfx.pixel(n(x), n(y), onFlag(on)),
      line: (
        x0: unknown,
        y0: unknown,
        x1: unknown,
        y1: unknown,
        on?: unknown,
      ) => gfx.line(n(x0), n(y0), n(x1), n(y1), onFlag(on)),
      rect: (x: unknown, y: unknown, w: unknown, h: unknown, on?: unknown) =>
        gfx.rect(n(x), n(y), n(w), n(h), onFlag(on)),
      rectfill: (
        x: unknown,
        y: unknown,
        w: unknown,
        h: unknown,
        on?: unknown,
      ) => gfx.rectFill(n(x), n(y), n(w), n(h), onFlag(on)),
      circle: (x: unknown, y: unknown, r: unknown, on?: unknown) =>
        gfx.circle(n(x), n(y), n(r), onFlag(on)),
      circfill: (x: unknown, y: unknown, r: unknown, on?: unknown) =>
        gfx.circleFill(n(x), n(y), n(r), onFlag(on)),
      print: (text: unknown, x: unknown, y: unknown, on?: unknown) =>
        gfx.print(String(text ?? ""), n(x), n(y), onFlag(on)),
      text_width: (text: unknown): number => gfx.textWidth(String(text ?? "")),
    },

    fs: {
      read: (path: unknown): string => device.sd.readTextFileSync(String(path)),
      write: (path: unknown, data: unknown): void =>
        device.sd.writeFileSync(String(path), String(data ?? "")),
      exists: (path: unknown): boolean => device.sd.existsSync(String(path)),
      list: (path: unknown) =>
        device.sd.readDirSync(String(path)).map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
        })),
      mkdir: (path: unknown): void => device.sd.mkdirSync(String(path), true),
      remove: (path: unknown): void => device.sd.removeSync(String(path)),
      stat: (path: unknown) => {
        const s = device.sd.statSync(String(path));
        return s
          ? { name: s.name, path: s.path, type: s.type, size: s.size }
          : null;
      },
    },

    sound: {
      tone: (freqHz: unknown, durMs?: unknown): void =>
        device.audio.playTone(n(freqHz), durMs === undefined ? 120 : n(durMs)),
    },

    time: (): number => ctx.getTimeMs() / 1000,
    log: (...args: unknown[]): void => ctx.log(args.map(String).join(" ")),

    // Native C accelerator modules the game declared (empty table if none).
    native: buildNativeApi(ctx.native ?? {}),
  };
}
