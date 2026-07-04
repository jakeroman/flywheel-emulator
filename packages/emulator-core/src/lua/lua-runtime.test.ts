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

  it("keeps Menu as the home button until a game claims it", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    device.gamepad.press("Menu"); // physically held
    device.gamepad.poll();
    await rt.load(
      [
        `fw.log(tostring(fw.MENU))`, // the id always exists
        `fw.log(tostring(fw.btn("Menu")))`, // but isn't readable by default
        `fw.custom_menu_button(true)`, // claim it
        `fw.log(tostring(fw.btn("Menu")))`, // now it reads the held button
      ].join("\n"),
    );
    expect(logs).toEqual(["Menu", "false", "true"]);
    expect(rt.capturesMenu).toBe(true); // the BIOS sees the claim

    // A fresh load reverts to the default (Menu is the home button again).
    await rt.load(`fw.log(tostring(fw.btn("Menu")))`);
    expect(rt.capturesMenu).toBe(false);
    expect(logs.at(-1)).toBe("false");
    await rt.dispose();
  });

  it("exposes fw.exit() as a one-shot request the host reads and clears", async () => {
    const device = new EmulatedFlywheelDevice();
    const rt = new LuaRuntime(device, {});
    await rt.load(`function _update() fw.exit() end`);
    expect(rt.exitRequested).toBe(false); // nothing asked yet
    device.gamepad.poll();
    rt.update(0.016); // _update calls fw.exit()
    expect(rt.exitRequested).toBe(true);
    // Reloading (what the BIOS restart does) clears the request.
    await rt.load(`function _update() end`);
    expect(rt.exitRequested).toBe(false);
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

    for (const path of [
      "/games/demo/main.lua",
      "/games/snake/main.lua",
      "/games/save-demo/main.lua",
      "/games/loop-demo/main.lua",
    ]) {
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

  it("persists fw.save across a reload and scopes it to the save dir", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const script = `
      function _init()
        local n = fw.save.get("n", 0)
        fw.log("n=" .. n)
        fw.save.set("n", n + 1)
        fw.log("dir=" .. fw.save.dir)
      end
    `;

    const run = async (saveDir: string) => {
      const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
      await rt.load(script, {}, saveDir);
      await rt.dispose();
    };

    await run("/saves/g1");
    await run("/saves/g1"); // same game: sees its own persisted value
    await run("/saves/g2"); // different game: isolated, starts at 0

    expect(logs.filter((l) => l.startsWith("n="))).toEqual([
      "n=0",
      "n=1",
      "n=0",
    ]);
    expect(logs).toContain("dir=/saves/g1");
    // The store lives where the game was told, not in the game's own dir.
    expect(device.sd.existsSync("/saves/g1/save.json")).toBe(true);
    expect(device.sd.existsSync("/saves/g2/save.json")).toBe(true);
  });

  it("returns Lua nil (not a truthy sentinel) for an unset save key", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(
      `function _init()
        local v = fw.save.get("nope")
        fw.log("isnil=" .. tostring(v == nil))
        fw.log("type=" .. type(v))
        -- The documented idiom must work:
        local hs = fw.save.get("highscore")
        if hs == nil then hs = 0 end
        fw.log("hs=" .. hs)
        -- Setting nil clears a key so it reads back as nil.
        fw.save.set("k", 5)
        fw.save.set("k", nil)
        fw.log("cleared=" .. tostring(fw.save.get("k") == nil))
      end`,
      {},
      "/saves/niltest",
    );
    await rt.dispose();
    expect(logs).toContain("isnil=true");
    expect(logs).toContain("type=nil");
    expect(logs).toContain("hs=0");
    expect(logs).toContain("cleared=true");
  });

  it("round-trips a Lua table through fw.save", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const write = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await write.load(
      `function _init() fw.save.set("hi", { best = 9, name = "ADA" }) end`,
      {},
      "/saves/t",
    );
    await write.dispose();

    const read = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await read.load(
      `function _init()
        local t = fw.save.get("hi")
        fw.log(t.name .. ":" .. t.best)
      end`,
      {},
      "/saves/t",
    );
    await read.dispose();
    expect(logs).toContain("ADA:9");
  });

  it("blits a bitmap from a Lua array (off-pixels) and a NUL-free string", async () => {
    const device = new EmulatedFlywheelDevice();
    const rt = new LuaRuntime(device);
    await rt.load(`
      function _draw()
        fw.gfx.cls()
        -- Array is the reliable Lua bitmap format: 2x2 checkerboard on/off // off/on.
        fw.gfx.blit({ 1, 0, 0, 1 }, 5, 5, 2, 2)
        -- A NUL-free string works too (all-on 2x2). (Embedded 0 bytes truncate
        -- across the wasmoon string bridge — see the blit docs — so bitmaps with
        -- off-pixels should use an array in the emulator.)
        fw.gfx.blit(string.char(1, 1, 1, 1), 10, 10, 2, 2)
      end
    `);
    rt.draw();
    // Array with 0 bytes: checkerboard survives intact.
    expect(device.display.getPixel(5, 5)).toBe(true);
    expect(device.display.getPixel(6, 5)).toBe(false);
    expect(device.display.getPixel(5, 6)).toBe(false);
    expect(device.display.getPixel(6, 6)).toBe(true);
    // NUL-free string: all four on.
    expect(device.display.getPixel(10, 10)).toBe(true);
    expect(device.display.getPixel(11, 10)).toBe(true);
    expect(device.display.getPixel(10, 11)).toBe(true);
    expect(device.display.getPixel(11, 11)).toBe(true);
    await rt.dispose();
  });

  it("takes a fill level (0..1) through fw.gfx for gray shades", async () => {
    const device = new EmulatedFlywheelDevice();
    const rt = new LuaRuntime(device);
    await rt.load(`
      function _draw()
        fw.gfx.cls()
        fw.gfx.rectfill(0, 0, 4, 4, 0.5)   -- 50% gray
        fw.gfx.rectfill(10, 0, 4, 4)       -- solid dark (default fill 1)
      end
    `);
    rt.draw();
    let gray = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) if (device.display.getPixel(x, y)) gray++;
    expect(gray).toBe(8); // half of the 4x4 tile inked
    // The default fill is fully inked (dark).
    let solid = 0;
    for (let y = 0; y < 4; y++)
      for (let x = 10; x < 14; x++) if (device.display.getPixel(x, y)) solid++;
    expect(solid).toBe(16);
    await rt.dispose();
  });

  it("loads sibling modules from the game dir via require()", async () => {
    const device = new EmulatedFlywheelDevice();
    device.sd.mkdirSync("/games/req/lib", true);
    device.sd.writeFileSync(
      "/games/req/vec.lua",
      `return { add = function(a, b) return a + b end }`,
    );
    device.sd.writeFileSync("/games/req/lib/greet.lua", `return "hi from lib"`);
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(
      `local vec = require("vec")
       local greet = require("lib/greet")
       function _init()
         fw.log("sum=" .. vec.add(2, 3))
         fw.log(greet)
         -- caching: a second require returns the same table.
         fw.log("cached=" .. tostring(require("vec") == vec))
       end`,
      {},
      undefined,
      "/games/req",
    );
    await rt.dispose();
    expect(logs).toContain("sum=5");
    expect(logs).toContain("hi from lib");
    expect(logs).toContain("cached=true");
  });

  it("require() can't escape the game dir and errors on a missing module", async () => {
    const device = new EmulatedFlywheelDevice();
    device.sd.mkdirSync("/games/req", true);
    device.sd.writeFileSync("/secret.lua", `return "leaked"`);
    const errors: Error[] = [];
    const rt = new LuaRuntime(device, { onError: (e) => errors.push(e) });
    const ok = await rt.load(
      `local x = require("../secret")`,
      {},
      undefined,
      "/games/req",
    );
    expect(ok).toBe(false);
    expect(errors[0]?.message).toMatch(/module not found/);
    await rt.dispose();
  });

  it("exposes read-only battery state via fw.battery()", async () => {
    const device = new EmulatedFlywheelDevice({ initialBatteryLevel: 0.5 });
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      function _init()
        local b = fw.battery()
        fw.log("pct=" .. b.percent)
        fw.log("has_level=" .. tostring(b.level ~= nil))
        fw.log("chg=" .. tostring(b.charging))
      end
    `);
    await rt.dispose();
    expect(logs).toContain("pct=50");
    expect(logs).toContain("has_level=true");
  });

  it("fw.clock() advances within a frame while fw.time() stays frozen", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    // A deterministic monotonic clock: +5ms per read.
    let ms = 1000;
    const rt = new LuaRuntime(
      device,
      { onLog: (m) => logs.push(m) },
      { now: () => (ms += 5) },
    );
    await rt.load(`
      function _init()
        local a = fw.clock()
        local b = fw.clock()        -- same frame, but real time moved
        fw.log("clock_delta=" .. (b - a))
        fw.log("time=" .. fw.time()) -- frame clock: still 0 in _init
      end
    `);
    rt.draw();
    expect(logs).toContain("clock_delta=5"); // advanced within the frame
    expect(logs).toContain("time=0"); // frame clock frozen (no update() yet)
    await rt.dispose();
  });

  it("runs a v1-style top-level loop as a coroutine (main mode)", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    const ok = await rt.load(`
      local frame = 0
      while true do
        frame = frame + 1
        fw.gfx.cls()
        fw.gfx.print("F" .. frame, 0, 0)
        fw.log("frame " .. frame)
        fw.flip()             -- yield: host presents + resumes next frame
      end
    `);
    expect(ok).toBe(true);
    expect(rt.status).toBe("running");
    // The first frame runs at load, up to the first flip.
    expect(logs).toEqual(["frame 1"]);
    expect(inkCount(device)).toBeGreaterThan(0);

    rt.update(0.016);
    rt.draw(); // no-op in main mode
    rt.update(0.016);
    rt.draw();
    expect(logs).toEqual(["frame 1", "frame 2", "frame 3"]);
    await rt.dispose();
  });

  it("treats fw.gfx.refresh() as the frame yield in main mode", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      local n = 0
      while true do
        n = n + 1
        fw.gfx.cls()
        fw.gfx.pixel(0, 0, true)
        fw.log("r" .. n)
        fw.gfx.refresh()      -- v1 muscle memory: present == yield
      end
    `);
    expect(logs).toEqual(["r1"]);
    rt.update(0.016);
    expect(logs).toEqual(["r1", "r2"]);
    expect(device.display.getPixel(0, 0)).toBe(true);
    await rt.dispose();
  });

  it("fw.wait / sleep yields across frames without blocking", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      fw.log("a")
      fw.wait(0.05)           -- ~0.05s of real frames, cooperatively
      fw.log("b")
      while true do fw.flip() end
    `);
    expect(logs).toEqual(["a"]); // suspended inside wait
    rt.update(0.02); // t=0.02
    rt.update(0.02); // t=0.04
    expect(logs).toEqual(["a"]);
    rt.update(0.02); // t=0.06 >= 0.05 → resumes
    expect(logs).toEqual(["a", "b"]);
    await rt.dispose();
  });

  it("still uses callbacks when the script defines _update/_draw", async () => {
    const device = new EmulatedFlywheelDevice();
    const logs: string[] = [];
    const rt = new LuaRuntime(device, { onLog: (m) => logs.push(m) });
    await rt.load(`
      function _init() fw.log("init") end
      function _update(dt) fw.log("update") end
      function _draw() fw.gfx.pixel(1, 1, true) end
    `);
    expect(logs).toEqual(["init"]); // _init ran, no top-level loop
    rt.update(0.016);
    rt.draw();
    expect(logs).toEqual(["init", "update"]);
    expect(device.display.getPixel(1, 1)).toBe(true);
    await rt.dispose();
  });
});
