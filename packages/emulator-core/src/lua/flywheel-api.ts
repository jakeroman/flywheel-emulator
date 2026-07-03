import type { FlywheelDevice } from "../hal/device.js";
import { ALL_BUTTONS, Button } from "../hal/gamepad.js";
import type { Graphics } from "../gfx/graphics.js";
import type { AcceleratorRuntime } from "../exec/module-runtime.js";
import { buildNativeApi } from "./native-bridge.js";
import { createSaveApi } from "./save-store.js";

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
 *   fw.gfx.{cls,pixel,line,rect,rectfill,circle,circfill,print,text_width,
 *           blit,refresh}   (draw ops take a fill 0..1: 0=light, 1=dark, gray between)
 *   fw.fs.{read,write,exists,list,mkdir,remove,stat}   resident SD (sync)
 *   fw.save.{get,set,has,delete,keys,clear,dir}   per-game save store
 *   fw.sound.tone(hz, ms)
 *   fw.battery()                   read-only { level, percent, charging, volts }
 *   fw.time()                      seconds of game time (a per-frame clock)
 *   fw.clock()                     real monotonic ms — for profiling, not logic
 *   fw.log(...)                    write to the dev console
 *
 * The LuaRuntime layers the main-loop primitives on top of this table for
 * v1-style games that own their loop: fw.flip(), fw.wait(s), fw.dt(), a
 * yielding fw.gfx.refresh(), and a global sleep(ms). See lua-runtime.ts.
 */
export interface FlywheelApiContext {
  device: FlywheelDevice;
  gfx: Graphics;
  getTimeMs: () => number;
  /** Real monotonic wall-clock in ms (performance.now-style), for `fw.clock()`.
   *  Non-deterministic — profiling only, never game logic. Defaults to
   *  performance.now()/Date.now() if omitted. */
  now?: () => number;
  log: (message: string) => void;
  /** Loaded native accelerator modules exposed as `fw.native.<name>` (the
   *  game's declared C helpers). Omit for a game with none. */
  native?: Record<string, AcceleratorRuntime>;
  /** This game's save directory, e.g. "/saves/snake". Backs `fw.save`; a game
   *  never sees other games' saves. Defaults to a scratch dir if omitted. */
  saveDir?: string;
}

const BUTTON_SET: ReadonlySet<string> = new Set(ALL_BUTTONS);

/** Real monotonic wall-clock in ms. `performance.now()` where available (Node +
 *  browser, sub-ms and monotonic), else `Date.now()`. Backs `fw.clock()`. */
const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export function createFlywheelApi(
  ctx: FlywheelApiContext,
): Record<string, unknown> {
  const { device, gfx } = ctx;
  const now = ctx.now ?? defaultNow;

  // Menu is reserved by the BIOS as the system/home button; games never see it.
  const toButton = (v: unknown): Button | null =>
    typeof v === "string" && BUTTON_SET.has(v) && v !== Button.Menu
      ? (v as Button)
      : null;
  // Coerce to a finite number; NaN/Infinity → 0 so they can't reach the
  // Bresenham/circle loops (where Infinity would never terminate).
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  // The fill/shade for a draw op: 0 = light (ground), 1 = dark (ink), between =
  // an ordered gray. nil/omitted → the op's default; a boolean maps true→1,
  // false→0 (the old on-flag). Clamped to [0,1].
  const fillOf = (v: unknown, dflt: number): number => {
    if (v === undefined || v === null) return dflt;
    if (typeof v === "boolean") return v ? 1 : 0;
    const x = n(v);
    return x <= 0 ? 0 : x >= 1 ? 1 : x;
  };

  // A 1-byte-per-pixel bitmap source for blit(): a native buffer (.raw()), a Lua
  // array of byte values, or a Lua string (each char a pixel byte, à la v1's
  // drawBitmap). Nonzero = an "on" (dark) pixel. NOTE: wasmoon reads Lua strings
  // as NUL-terminated, so a string with 0 (off) bytes truncates at the first 0 —
  // use an ARRAY for bitmaps with off-pixels in the emulator (strings are fine on
  // hardware, which passes an explicit length).
  const asByteSource = (
    buf: unknown,
  ): { length: number; at: (i: number) => number } | null => {
    if (typeof buf === "string")
      return { length: buf.length, at: (i) => buf.charCodeAt(i) & 0xff };
    if (Array.isArray(buf))
      return { length: buf.length, at: (i) => Number(buf[i]) & 0xff };
    if (buf && typeof (buf as { raw?: unknown }).raw === "function") {
      const raw = (buf as { raw(): Uint8Array }).raw();
      return { length: raw.length, at: (i) => raw[i] };
    }
    return null;
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
      cls: (fill?: unknown) => gfx.clear(fillOf(fill, 0)),
      pixel: (x: unknown, y: unknown, fill?: unknown) =>
        gfx.pixel(n(x), n(y), fillOf(fill, 1)),
      line: (
        x0: unknown,
        y0: unknown,
        x1: unknown,
        y1: unknown,
        fill?: unknown,
      ) => gfx.line(n(x0), n(y0), n(x1), n(y1), fillOf(fill, 1)),
      rect: (x: unknown, y: unknown, w: unknown, h: unknown, fill?: unknown) =>
        gfx.rect(n(x), n(y), n(w), n(h), fillOf(fill, 1)),
      rectfill: (
        x: unknown,
        y: unknown,
        w: unknown,
        h: unknown,
        fill?: unknown,
      ) => gfx.rectFill(n(x), n(y), n(w), n(h), fillOf(fill, 1)),
      circle: (x: unknown, y: unknown, r: unknown, fill?: unknown) =>
        gfx.circle(n(x), n(y), n(r), fillOf(fill, 1)),
      circfill: (x: unknown, y: unknown, r: unknown, fill?: unknown) =>
        gfx.circleFill(n(x), n(y), n(r), fillOf(fill, 1)),
      print: (
        text: unknown,
        x: unknown,
        y: unknown,
        fill?: unknown,
        scale?: unknown,
      ) => gfx.print(String(text ?? ""), n(x), n(y), fillOf(fill, 1), n(scale)),
      text_width: (text: unknown, scale?: unknown): number =>
        gfx.textWidth(String(text ?? ""), n(scale)),
      // Draw a w×h, 1-byte-per-pixel bitmap at (x,y): a nonzero byte is an "on"
      // (dark) pixel. The source is a native buffer (C fills a framebuffer, HAL
      // blits it), a Lua string (each char a byte, like v1's drawBitmap), or a
      // Lua array of bytes.
      blit: (
        buf: unknown,
        x: unknown,
        y: unknown,
        w: unknown,
        h: unknown,
      ): void => {
        const src = asByteSource(buf);
        if (!src) return;
        const ox = n(x);
        const oy = n(y);
        const bw = n(w);
        const bh = n(h);
        // Opaque: every cell sets its pixel (on OR off), so a full-frame blit
        // needs no cls and never ghosts the previous frame.
        for (let row = 0; row < bh; row++) {
          const base = row * bw;
          for (let col = 0; col < bw; col++) {
            const i = base + col;
            if (i >= src.length) return;
            gfx.pixel(ox + col, oy + row, src.at(i) !== 0);
          }
        }
      },
      // Present the framebuffer to the panel. The emulator auto-presents after
      // each _draw(), so this is a no-op here; on real hardware it pushes the
      // frame to the Sharp memory LCD. Call it to keep game code identical on
      // device. (Drawing is already atomic per frame, so it isn't a flicker fix.)
      refresh: (): void => {},
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

    // Per-game persistent save store (key → JSON-serializable value). Scoped to
    // this game's save dir, so a game can save/load data without knowing its own
    // path and can't reach another game's saves.
    save: createSaveApi(device.sd, ctx.saveDir ?? "/saves/_scratch"),

    sound: {
      tone: (freqHz: unknown, durMs?: unknown): void =>
        device.audio.playTone(n(freqHz), durMs === undefined ? 120 : n(durMs)),
    },

    // Read-only power state for a HUD/indicator: level 0..1, percent 0..100,
    // charging flag, and terminal voltage. Games can't change power (the BIOS
    // owns modes/sleep) — unlike v1, which exposed raw ADC pins.
    battery: (): Record<string, unknown> => {
      const s = device.power.getSnapshot();
      return {
        level: s.level,
        percent: Math.round(s.level * 100),
        charging: s.charging,
        volts: s.voltage,
      };
    },

    time: (): number => ctx.getTimeMs() / 1000,
    // Real elapsed wall-clock in ms, for profiling. Unlike fw.time() (a frozen
    // per-frame clock) this advances continuously — measure durations WITHIN a
    // frame with it. Non-deterministic, so keep it out of game logic/replays.
    clock: (): number => now(),
    log: (...args: unknown[]): void => ctx.log(args.map(String).join(" ")),

    // Native C accelerator modules the game declared (empty table if none).
    native: buildNativeApi(ctx.native ?? {}),
  };
}
