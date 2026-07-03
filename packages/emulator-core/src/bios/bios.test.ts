import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { MemorySDCard, seedMockContent } from "../device/memory-sd.js";
import { EspMode } from "../hal/power.js";
import type { Button } from "../hal/gamepad.js";
import { scanGames } from "./game-scan.js";
import { loadSettings } from "./settings.js";
import { Bios } from "./bios.js";

async function bootedWithGames(): Promise<{
  device: EmulatedFlywheelDevice;
  bios: Bios;
}> {
  const device = new EmulatedFlywheelDevice();
  await seedMockContent(device.sd); // demo + snake + ripple + save-demo → 4 games
  const bios = new Bios(device);
  device.powerOn();
  bios.boot();
  bios.update(2.0); // elapse the boot splash
  return { device, bios };
}

/** Tap a button (press+release) and process one frame, like the run loop. */
function tap(device: EmulatedFlywheelDevice, bios: Bios, button: Button): void {
  device.gamepad.press(button);
  device.gamepad.release(button);
  device.gamepad.poll();
  bios.update(0.05);
}

function litPixels(device: EmulatedFlywheelDevice): number {
  const buf = device.display.getPackedBuffer();
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    let b = buf[i];
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

describe("scanGames", () => {
  it("finds games with a main.lua and reads titles from meta.lua", async () => {
    const sd = new MemorySDCard();
    await seedMockContent(sd);
    const games = scanGames(sd);
    expect(games.map((g) => g.title).sort()).toEqual([
      "Bounce Demo",
      "Loop Demo",
      "Ripple (C)",
      "Save Demo",
      "Snake",
    ]);
    expect(games.every((g) => g.mainPath.endsWith("/main.lua"))).toBe(true);
  });

  it("falls back to the folder name and skips dirs without main.lua", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync("/games/untitled", true);
    sd.writeFileSync("/games/untitled/main.lua", "");
    sd.mkdirSync("/games/empty", true); // no main.lua or game.json → skipped
    const games = scanGames(sd);
    expect(games.map((g) => g.id)).toEqual(["untitled"]);
    expect(games[0].title).toBe("untitled");
  });

  it("lists a game that has only a game.json (custom entry, no main.lua)", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync("/games/native", true);
    sd.writeFileSync("/games/native/start.lua", "");
    sd.writeFileSync(
      "/games/native/game.json",
      JSON.stringify({ entry: "start.lua" }),
    );
    const games = scanGames(sd);
    expect(games.map((g) => g.id)).toEqual(["native"]);
  });

  it("clamps long titles and collapses control chars", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync("/games/a", true);
    sd.writeFileSync("/games/a/main.lua", "");
    sd.writeFileSync(
      "/games/a/meta.lua",
      `return { title = "${"X".repeat(80)}" }`,
    );
    sd.mkdirSync("/games/b", true);
    sd.writeFileSync("/games/b/main.lua", "");
    sd.writeFileSync("/games/b/meta.lua", 'return { title = "line1\nline2" }');
    const byId = Object.fromEntries(scanGames(sd).map((g) => [g.id, g.title]));
    expect(byId.a.length).toBe(40);
    expect(byId.b).toBe("line1 line2");
  });
});

describe("settings", () => {
  it("sanitizes malformed settings.json (null wifi entries, non-numeric level)", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync("/system", true);
    sd.writeFileSync(
      "/system/settings.json",
      JSON.stringify({ wifi: [null, 42, { ssid: "ok" }], lastLevel: "abc" }),
    );
    const s = loadSettings(sd);
    expect(s.lastLevel).toBe(0);
    expect(s.wifi).toEqual([{ ssid: "" }, { ssid: "" }, { ssid: "ok" }]);
  });
});

describe("Bios", () => {
  it("boots into the game selector with multiple games", async () => {
    const { bios } = await bootedWithGames();
    const s = bios.snapshot();
    expect(s.screen).toBe("menu");
    expect(s.games.map((g) => g.title).sort()).toEqual([
      "Bounce Demo",
      "Loop Demo",
      "Ripple (C)",
      "Save Demo",
      "Snake",
    ]);
  });

  it("navigates the selector and opens settings", async () => {
    const { device, bios } = await bootedWithGames();
    const n = bios.snapshot().games.length; // seeded games
    expect(bios.snapshot().selectedIndex).toBe(0);
    tap(device, bios, "Down");
    expect(bios.snapshot().selectedIndex).toBe(1);
    for (let i = 0; i < n - 1; i++) tap(device, bios, "Down"); // wrap back to 0
    expect(bios.snapshot().selectedIndex).toBe(0);

    tap(device, bios, "Menu");
    expect(bios.snapshot().screen).toBe("settings");
    tap(device, bios, "B");
    expect(bios.snapshot().screen).toBe("menu");
  });

  it("auto-runs the only game via a countdown", async () => {
    const device = new EmulatedFlywheelDevice();
    device.sd.mkdirSync("/games/solo", true);
    device.sd.writeFileSync("/games/solo/main.lua", "function _draw() end");
    const bios = new Bios(device);
    device.powerOn();
    bios.boot();
    bios.update(2.0);
    expect(bios.snapshot().screen).toBe("countdown");
  });

  it("launches a script and can return to the menu", async () => {
    const { device, bios } = await bootedWithGames();
    await bios.launchScript("/games/snake/main.lua");
    expect(bios.snapshot().screen).toBe("game");
    expect(bios.snapshot().gameStatus).toBe("running");

    bios.returnToMenu();
    expect(bios.snapshot().screen).toBe("menu");
    expect(bios.snapshot().gameStatus).toBe("idle");
    void device;
  });

  it("scopes a launched game's fw.save to /saves/<game>", async () => {
    const { device, bios } = await bootedWithGames();
    device.sd.mkdirSync("/games/saver", true);
    device.sd.writeFileSync(
      "/games/saver/main.lua",
      `function _init() fw.save.set("hp", 42) end`,
    );
    await bios.launchScript("/games/saver/main.lua");
    expect(bios.snapshot().gameStatus).toBe("running");
    // The save landed under /saves/<game folder>, not in the game dir.
    expect(device.sd.existsSync("/saves/saver/save.json")).toBe(true);
    expect(device.sd.readTextFileSync("/saves/saver/save.json")).toContain(
      "42",
    );
    expect(device.sd.existsSync("/games/saver/save.json")).toBe(false);
  });

  it("keeps a traversal-y entry path from escaping /saves", async () => {
    const { device, bios } = await bootedWithGames();
    device.sd.writeFileSync(
      "/main.lua",
      `function _init() fw.save.set("x", 1) end`,
    );
    // dirname("/../main.lua") basename is "..": must not resolve to /saves/..
    // (which normalizes to /). The save must land under /saves, not root.
    await bios.launchScript("/../main.lua");
    expect(bios.snapshot().gameStatus).toBe("running");
    expect(device.sd.existsSync("/save.json")).toBe(false);
    const underSaves = device.sd
      .readDirSync("/saves")
      .some((e) => e.type === "dir" && device.sd.existsSync(`${e.path}/save.json`));
    expect(underSaves).toBe(true);
  });

  it("gives folders that sanitize to the same slug separate saves", async () => {
    const { device, bios } = await bootedWithGames();
    // "my game" (space) and "my_game" both slug to "my_game"; they must not
    // share one save.json.
    for (const [dir, val] of [
      ["/games/my game", 1],
      ["/games/my_game", 2],
    ] as const) {
      device.sd.mkdirSync(dir, true);
      device.sd.writeFileSync(
        `${dir}/main.lua`,
        `function _init() fw.save.set("v", ${val}) end`,
      );
      await bios.launchScript(`${dir}/main.lua`);
    }
    // Re-launch the first; it must still read its own value, not the second's.
    device.sd.writeFileSync(
      "/games/my game/main.lua",
      `function _init() fw.log("v=" .. fw.save.get("v", -1)) end`,
    );
    const logs: string[] = [];
    const off = bios.events.on("log", (m) => logs.push(m));
    await bios.launchScript("/games/my game/main.lua");
    off();
    expect(logs).toContain("v=1");
  });

  it("populates the game list when launchScript runs from a powered-off device", async () => {
    const device = new EmulatedFlywheelDevice();
    await seedMockContent(device.sd); // seeded games
    const bios = new Bios(device);
    // Device is OFF and not booted; dev-launch a script directly.
    await bios.launchScript("/games/snake/main.lua");
    expect(bios.snapshot().screen).toBe("game");
    // Returning to the menu must show the games, not "No games on SD card".
    bios.returnToMenu();
    const s = bios.snapshot();
    expect(s.screen).toBe("menu");
    expect(s.games.length).toBeGreaterThan(0);
  });

  it("reports charge gained since the last boot", async () => {
    const device = new EmulatedFlywheelDevice({ initialBatteryLevel: 0.9 });
    await seedMockContent(device.sd);
    device.sd.writeFileSync(
      "/system/settings.json",
      JSON.stringify({ wifi: [], lastLevel: 0.5 }),
    );
    const bios = new Bios(device);
    device.powerOn();
    bios.boot();
    const report = bios.bootChargeReport;
    expect(report?.gainedLevel).toBeCloseTo(0.4, 5);
    expect(report?.estPlaytimeMin).toBeGreaterThan(0);
  });

  it("launches a native wasm32 module as a game (not Lua)", async () => {
    // The committed wasm32 fixture, placed on the SD as a game's entry.
    const fixture = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../tools/fwmod/fixtures/hello-wasm32.fwmod",
    );
    const device = new EmulatedFlywheelDevice();
    device.sd.mkdirSync("/games/native", true);
    device.sd.writeFileSync(
      "/games/native/app.fwmod",
      new Uint8Array(readFileSync(fixture)),
    );

    const bios = new Bios(device);
    // launchScript awaits start(), which routes a .fwmod entry to the wasm
    // backend and awaits instantiation — deterministic, unlike the menu path.
    await bios.launchScript("/games/native/app.fwmod");

    expect(bios.snapshot().screen).toBe("game");
    expect(bios.snapshot().gameStatus).toBe("running");
    bios.draw();
    expect(litPixels(device)).toBeGreaterThan(0); // the C/wasm module drew
    bios.dispose();
  });

  it("loads a Lua game's declared native accelerator and lets it call in", async () => {
    // A Lua game that offloads work to a C helper declared in its game.json.
    const fixture = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../tools/fwmod/fixtures/fxmod-clang-wasm32.fwmod",
    );
    const device = new EmulatedFlywheelDevice();
    device.sd.mkdirSync("/games/fx", true);
    device.sd.writeFileSync(
      "/games/fx/helper.fwmod",
      new Uint8Array(readFileSync(fixture)),
    );
    device.sd.writeFileSync(
      "/games/fx/game.json",
      JSON.stringify({
        entry: "main.lua",
        modules: [{ name: "fx", path: "helper.fwmod" }],
      }),
    );
    device.sd.writeFileSync(
      "/games/fx/main.lua",
      [
        "local fx = fw.native.fx",
        "local buf",
        "function _init() buf = fx.alloc(64) end",
        "function _update(dt) fx.shade(buf, 8, 8, 5); fw.log('sum=' .. math.floor(fx.sum(buf, 64))) end",
        "function _draw() if buf.get(0) % 2 == 1 then fw.gfx.pixel(0, 0, true) end end",
      ].join("\n"),
    );

    const logs: string[] = [];
    const bios = new Bios(device);
    bios.events.on("log", (m) => logs.push(m));
    await bios.launchScript("/games/fx/main.lua");
    expect(bios.snapshot().gameStatus).toBe("running");

    bios.update(0.016); // Lua offloads to C, logs the sum
    bios.draw(); // Lua reads a byte back and plots a pixel

    expect(logs.some((l) => l.includes("fx: loaded (2 exports)"))).toBe(true);
    expect(logs.some((l) => l.includes("768"))).toBe(true); // the C reduction
    expect(litPixels(device)).toBeGreaterThan(0); // buf[0]=5 (odd) → pixel on
    bios.dispose();
  });

  it("runs the seeded C-accelerated Ripple demo end-to-end", async () => {
    const device = new EmulatedFlywheelDevice();
    await seedMockContent(device.sd); // includes /games/ripple + ripple.fwmod
    const bios = new Bios(device);
    await bios.launchScript("/games/ripple/main.lua");
    expect(bios.snapshot().gameStatus).toBe("running");

    bios.update(0.016);
    bios.draw();
    const lit = litPixels(device);
    // The C render() produced a real pattern: some pixels on, some off.
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(400 * 240);
    bios.dispose();
  });

  it("clears the display on power-off", async () => {
    const { device, bios } = await bootedWithGames();
    bios.draw(); // render the menu
    expect(litPixels(device)).toBeGreaterThan(0);
    bios.shutdown();
    expect(litPixels(device)).toBe(0);
  });

  it("drops to light-sleep when idle in a menu", async () => {
    const { device, bios } = await bootedWithGames();
    expect(device.power.getSnapshot().espMode).toBe(EspMode.Active);
    // No input for longer than the idle threshold.
    device.gamepad.poll();
    bios.update(20);
    expect(device.power.getSnapshot().espMode).toBe(EspMode.LightSleep);
    // Any input wakes it back to active.
    tap(device, bios, "Down");
    expect(device.power.getSnapshot().espMode).toBe(EspMode.Active);
  });
});
