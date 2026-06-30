import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { Graphics } from "../gfx/graphics.js";
import { createWasmEnv } from "./wasm-imports.js";

type EnvFn = (...args: number[]) => number | void;

function cstr(memory: WebAssembly.Memory, ptr: number, s: string): number {
  const enc = new TextEncoder().encode(s);
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(enc, ptr);
  bytes[ptr + enc.length] = 0;
  return enc.length;
}

function setup() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const tones: Array<[number, number]> = [];
  const logs: string[] = [];
  const device = new EmulatedFlywheelDevice({
    audio: {
      enabled: false,
      setEnabled() {},
      playTone: (hz, ms) => tones.push([hz, ms]),
      playSamples() {},
      stop() {},
    },
  });
  const gfx = new Graphics(device.display);
  const env = createWasmEnv({
    memory,
    device,
    gfx,
    getTimeMs: () => 1234,
    log: (m) => logs.push(m),
  }) as Record<string, EnvFn>;
  return { memory, device, gfx, env, tones, logs };
}

describe("createWasmEnv (wasm32 HAL bridge)", () => {
  it("graphics imports draw to the display via the HAL", () => {
    const { device, env } = setup();
    env.cls(0);
    expect(device.display.getPixel(2, 2)).toBe(false);
    env.rect(2, 2, 20, 20, 1);
    expect(device.display.getPixel(2, 2)).toBe(true); // corner of the outline
  });

  it("print + text_width marshal the string from linear memory", () => {
    const { memory, gfx, env } = setup();
    cstr(memory, 256, "HELLO");
    expect(env.text_width(256)).toBe(gfx.textWidth("HELLO"));
    expect(env.text_width(256)).toBeGreaterThan(0);
  });

  it("btn/btnp map fw_button_t ids to the gamepad (Menu not addressable)", () => {
    const { device, env } = setup();
    device.gamepad.press("A"); // FW_BTN_A == 4
    device.gamepad.poll();
    expect(env.btn(4)).toBe(1);
    expect(env.btnp(4)).toBe(1);
    expect(env.btn(0)).toBe(0); // Up, not pressed
    expect(env.btn(99)).toBe(0); // out-of-range id
  });

  it("fs_write / fs_exists / fs_read round-trip through the SD card", () => {
    const { memory, device, env } = setup();
    const pathPtr = 1000;
    const dataPtr = 1100;
    cstr(memory, pathPtr, "/note.txt");
    const len = cstr(memory, dataPtr, "hello");

    expect(env.fs_write(pathPtr, dataPtr, len)).toBe(0);
    expect(device.sd.existsSync("/note.txt")).toBe(true);
    expect(env.fs_exists(pathPtr)).toBe(1);

    const outPtr = 2000;
    const n = env.fs_read(pathPtr, outPtr, 64) as number;
    expect(n).toBe(len);
    const got = new TextDecoder().decode(
      new Uint8Array(memory.buffer).subarray(outPtr, outPtr + n),
    );
    expect(got).toBe("hello");

    expect(env.fs_read(3000 /* "/missing" */, outPtr, 64)).toBe(-1);
  });

  it("tone, time_ms, and log reach the HAL / hooks", () => {
    const { memory, env, tones, logs } = setup();
    env.tone(440, 100);
    expect(tones).toEqual([[440, 100]]);
    expect(env.time_ms()).toBe(1234);
    cstr(memory, 400, "beep");
    env.log(400);
    expect(logs).toEqual(["beep"]);
  });
});
