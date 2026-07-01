import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import type { AcceleratorRuntime } from "../exec/module-runtime.js";
import { WasmModuleRuntime } from "../exec/wasm-runtime.js";
import { XtensaModuleRuntime } from "../exec/xtensa/xtensa-runtime.js";
import { LuaRuntime } from "./lua-runtime.js";
import { buildNativeApi } from "./native-bridge.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): Uint8Array =>
  new Uint8Array(
    readFileSync(path.resolve(dirname, "../../../../tools/fwmod/fixtures", n)),
  );

const WASM = "fxmod-clang-wasm32.fwmod";
const XT = "fxmod-gcc-xtensa.fwmod";

// sum over an 8x8 buffer of (x + y + 5), no byte wrap (max 19) = 768.
const SHADE_SUM_8x8_T5 = 768;

type Backend = new (
  d: EmulatedFlywheelDevice,
) => AcceleratorRuntime & { load(b: Uint8Array): Promise<boolean> };

// A Lua game that offloads a fill + reduce to a C accelerator, then draws the
// buffer. Exercises: alloc, passing a buffer to an export, a scalar return, and
// reading bytes back from Lua.
const GAME = `
local fx = fw.native.fx
local buf
function _init() buf = fx.alloc(64) end
function _update(dt)
  fx.shade(buf, 8, 8, 5)
  fw.log("sum=" .. math.floor(fx.sum(buf, 64)))
end
function _draw()
  for y = 0, 7 do
    for x = 0, 7 do
      if buf.get(y * 8 + x) % 2 == 1 then fw.gfx.pixel(x, y, true) end
    end
  end
end
`;

describe("native bridge — buildNativeApi (headless)", () => {
  it("allocs, passes a buffer to an export, and reads bytes back", async () => {
    const device = new EmulatedFlywheelDevice();
    const rt = new WasmModuleRuntime(device);
    await rt.load(fixture(WASM));
    const fx = buildNativeApi({ fx: rt }).fx as Record<string, Function>;

    const buf = fx.alloc(64) as { ptr: number; length: number; get(i: number): number };
    expect(buf.length).toBe(64);
    expect(fx.shade(buf, 8, 8, 5)).toBe(64); // wrote w*h bytes
    expect(buf.get(0)).toBe(5); // (0+0+5)
    expect(buf.get(9)).toBe(7); // (1+1+5)
    expect(fx.sum(buf, 64)).toBe(SHADE_SUM_8x8_T5);
    rt.dispose();
  });
});

describe("native bridge — a Lua game calls a C accelerator (both backends)", () => {
  for (const [label, Runtime, name] of [
    ["wasm32", WasmModuleRuntime, WASM],
    ["xtensa", XtensaModuleRuntime, XT],
  ] as const) {
    it(`runs end-to-end on ${label}`, async () => {
      const device = new EmulatedFlywheelDevice();
      const accel = new (Runtime as Backend)(device);
      expect(await accel.load(fixture(name))).toBe(true);

      const logs: string[] = [];
      const lua = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
      const ok = await lua.load(GAME, { fx: accel });
      expect(ok).toBe(true);

      lua.update(0.016); // C fills + reduces the buffer, logs the sum
      lua.draw(); // Lua reads the buffer back and plots pixels

      expect(logs.some((l) => l.includes(String(SHADE_SUM_8x8_T5)))).toBe(true);
      // buf[0] = 5 (odd) → pixel on; buf[1] = 6 (even) → pixel off.
      expect(device.display.getPixel(0, 0)).toBe(true);
      expect(device.display.getPixel(1, 0)).toBe(false);

      await lua.dispose();
      accel.dispose();
    });
  }
});
