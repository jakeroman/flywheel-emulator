import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { LuaRuntime } from "./lua-runtime.js";

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
});
