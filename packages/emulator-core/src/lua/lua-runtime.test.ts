import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { seedMockContent } from "../device/memory-sd.js";
import { LuaRuntime } from "./lua-runtime.js";

function inkCount(device: EmulatedFlywheelDevice): number {
  const buf = device.display.getPackedBuffer();
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i];
    while (b) {
      bits += b & 1;
      b >>= 1;
    }
  }
  return bits;
}

describe("LuaRuntime", () => {
  it("runs the lifecycle and draws through fw.gfx", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const errors: Error[] = [];
    const rt = new LuaRuntime(device, {
      onLog: (m) => logs.push(m),
      onError: (e) => errors.push(e),
    });

    const ok = await rt.load(`
      function _init()
        print("init " .. fw.width .. "x" .. fw.height)
      end
      function _draw()
        fw.gfx.cls()
        fw.gfx.pixel(10, 20, true)
        fw.gfx.rect(0, 0, fw.width, fw.height)
        fw.gfx.print("HI", 4, 4)
      end
    `);

    expect(ok).toBe(true);
    expect(rt.status).toBe("running");
    expect(logs[0]).toContain("init 400x240");

    rt.draw();
    expect(errors).toEqual([]);
    expect(device.display.getPixel(10, 20)).toBe(true);
    expect(device.display.getPixel(0, 0)).toBe(true); // rect corner
    await rt.dispose();
  });

  it("reads input edges via fw.btnp", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      function _update(dt)
        if fw.btnp(fw.A) then fw.log("A!") end
      end
    `);

    device.gamepad.press("A");
    device.gamepad.poll();
    rt.update(0.016);

    device.gamepad.poll(); // no new press this frame
    rt.update(0.016);

    expect(logs.filter((l) => l === "A!")).toHaveLength(1);
    await rt.dispose();
  });

  it("reserves the Menu button (not exposed to games)", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    device.gamepad.press("Menu"); // physically held
    device.gamepad.poll();
    await rt.load(
      `fw.log(tostring(fw.MENU)); fw.log(tostring(fw.btn("Menu")))`,
    );
    expect(logs).toEqual(["nil", "false"]); // not exposed, and btn() guarded
    await rt.dispose();
  });

  it("reads and writes the SD card from Lua", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      fw.fs.write("/note.txt", "hello from lua")
      fw.log(fw.fs.read("/note.txt"))
    `);

    expect(logs).toContain("hello from lua");
    expect(device.sd.readTextFileSync("/note.txt")).toBe("hello from lua");
    await rt.dispose();
  });

  it("captures a per-frame runtime error and stops", async () => {
    const device = new EmulatedFlywheelDevice();
    const errors: Error[] = [];
    const rt = new LuaRuntime(device, { onError: (e) => errors.push(e) });
    const ok = await rt.load(`function _draw() error("boom") end`);
    expect(ok).toBe(true);

    rt.draw();
    expect(rt.status).toBe("error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("boom");

    rt.draw(); // no further calls once errored
    expect(errors).toHaveLength(1);
    await rt.dispose();
  });

  it("interrupts a runaway loop instead of hanging (function timeout)", async () => {
    const device = new EmulatedFlywheelDevice();
    const errors: Error[] = [];
    const rt = new LuaRuntime(
      device,
      { onError: (e) => errors.push(e) },
      { functionTimeoutMs: 50 },
    );
    await rt.load(`function _update() while true do end end`);
    rt.update(0.016); // would hang forever without the timeout hook
    expect(rt.status).toBe("error");
    expect(errors).toHaveLength(1);
    await rt.dispose();
  });

  it("reports a load-time syntax error", async () => {
    const device = new EmulatedFlywheelDevice();
    const errors: Error[] = [];
    const rt = new LuaRuntime(device, { onError: (e) => errors.push(e) });
    const ok = await rt.load(`function _draw( missing end`);
    expect(ok).toBe(false);
    expect(rt.status).toBe("error");
    expect(errors).toHaveLength(1);
    await rt.dispose();
  });

  it("loads and runs every seeded game without error", async () => {
    const device = new EmulatedFlywheelDevice();
    await seedMockContent(device.sd);

    for (const path of ["/games/demo/main.lua", "/games/snake/main.lua"]) {
      const errors: Error[] = [];
      const rt = new LuaRuntime(device, { onError: (e) => errors.push(e) });
      const ok = await rt.load(device.sd.readTextFileSync(path));
      expect(ok, path).toBe(true);

      // A few frames of input + update + draw.
      for (let i = 0; i < 12; i++) {
        device.gamepad.poll();
        rt.update(0.12);
        rt.draw();
      }
      expect(errors, path).toEqual([]);
      expect(rt.status, path).toBe("running");
      expect(inkCount(device), path).toBeGreaterThan(50); // it drew something
      await rt.dispose();
    }
  });
});
