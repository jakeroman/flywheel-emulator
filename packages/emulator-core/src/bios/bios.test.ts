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
  await seedMockContent(device.sd); // demo + snake → 2 games
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

describe("scanGames", () => {
  it("finds games with a main.lua and reads titles from meta.lua", async () => {
    const sd = new MemorySDCard();
    await seedMockContent(sd);
    const games = scanGames(sd);
    expect(games.map((g) => g.title)).toEqual(["Bounce Demo", "Snake"]);
    expect(games.every((g) => g.mainPath.endsWith("/main.lua"))).toBe(true);
  });

  it("falls back to the folder name and skips dirs without main.lua", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync("/games/untitled", true);
    sd.writeFileSync("/games/untitled/main.lua", "");
    sd.mkdirSync("/games/empty", true); // no main.lua → skipped
    const games = scanGames(sd);
    expect(games.map((g) => g.id)).toEqual(["untitled"]);
    expect(games[0].title).toBe("untitled");
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
    expect(s.games.map((g) => g.title)).toEqual(["Bounce Demo", "Snake"]);
  });

  it("navigates the selector and opens settings", async () => {
    const { device, bios } = await bootedWithGames();
    expect(bios.snapshot().selectedIndex).toBe(0);
    tap(device, bios, "Down");
    expect(bios.snapshot().selectedIndex).toBe(1);
    tap(device, bios, "Down"); // wraps
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
