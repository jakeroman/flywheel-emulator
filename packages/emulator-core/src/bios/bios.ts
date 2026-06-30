import { Emitter } from "../util/emitter.js";
import { Button, ALL_BUTTONS } from "../hal/gamepad.js";
import { EspMode, PowerConsumer } from "../hal/power.js";
import type { FlywheelDevice } from "../hal/device.js";
import { Graphics } from "../gfx/graphics.js";
import {
  LuaRuntime,
  type LuaRuntimeOptions,
  type LuaStatus,
} from "../lua/lua-runtime.js";
import { POWER_CONSTANTS } from "../device/power-model.js";
import { scanGames, type GameEntry } from "./game-scan.js";
import {
  loadSettings,
  saveSettings,
  WIFI_SLOTS,
  type BiosSettings,
} from "./settings.js";

export type BiosScreen = "boot" | "countdown" | "menu" | "settings" | "game";

export interface ChargeReport {
  /** Battery level delta since the last boot (0..1; negative if it drained). */
  gainedLevel: number;
  /** Rough playtime the gained charge buys, in minutes. */
  estPlaytimeMin: number;
}

export interface BiosSnapshot {
  screen: BiosScreen;
  games: ReadonlyArray<GameEntry>;
  selectedIndex: number;
  currentGameTitle: string | null;
  gameStatus: LuaStatus;
  error: string | null;
}

export interface BiosEvents {
  change: BiosSnapshot;
  log: string;
  error: string;
}

const FIRMWARE_VERSION = "0.2.0";
const BOOT_SPLASH_MS = 1600;
const COUNTDOWN_MS = 3000;
const IDLE_SLEEP_MS = 15000;

const W = 400;
const H = 240;

/**
 * The Flywheel BIOS: a host-side state machine that boots the device, scans the
 * SD card for games, presents the game selector and settings, launches games
 * (handing the display to the Lua runtime), and manages power modes. It runs
 * against the HAL + Graphics — it is not itself a Lua app, it's the system that
 * launches them. The host run loop polls the gamepad, then calls update()+draw().
 */
export class Bios {
  readonly events = new Emitter<BiosEvents>();
  private readonly gfx: Graphics;
  private readonly runtime: LuaRuntime;

  private screen: BiosScreen = "boot";
  private games: GameEntry[] = [];
  private selected = 0;
  private settingsSel = 0;
  private currentGame: GameEntry | null = null;
  private settings: BiosSettings;
  private error: string | null = null;
  private booted = false;

  private timerMs = 0; // per-screen countdown (boot splash, auto-run)
  private idleMs = 0; // time since last input, for light-sleep
  private chargeReport: ChargeReport | null = null;

  constructor(
    private readonly device: FlywheelDevice,
    options: LuaRuntimeOptions = {},
  ) {
    this.gfx = new Graphics(device.display);
    this.settings = loadSettings(device.sd);
    this.runtime = new LuaRuntime(
      device,
      {
        onLog: (m) => this.events.emit("log", m),
        onError: (e) => {
          this.error = e.message;
          this.events.emit("error", e.message);
          this.emit();
        },
      },
      options,
    );
  }

  get gameStatus(): LuaStatus {
    return this.runtime.status;
  }

  /** The charge comparison computed at the last boot (null before booting). */
  get bootChargeReport(): ChargeReport | null {
    return this.chargeReport;
  }

  snapshot(): BiosSnapshot {
    return {
      screen: this.screen,
      games: this.games,
      selectedIndex: this.selected,
      currentGameTitle: this.currentGame?.title ?? null,
      gameStatus: this.runtime.status,
      error: this.error,
    };
  }

  /** Power-on boot: scan games, compute the charge report, show the splash. */
  boot(): void {
    // Idempotent: a redundant boot (a remount, or launchScript powering on)
    // must not re-scan, re-record the charge baseline, or stomp a live game.
    if (this.booted) return;
    this.booted = true;
    this.error = null;
    this.settings = loadSettings(this.device.sd);
    this.games = scanGames(this.device.sd);
    this.selected = 0;
    this.settingsSel = 0;
    this.idleMs = 0;
    this.device.power.setEspMode(EspMode.Active);

    // Charge-on-boot comparison, then record the current level.
    const level = this.device.power.getSnapshot().level;
    const gained = level - (this.settings.lastLevel ?? 0);
    this.chargeReport = {
      gainedLevel: gained,
      estPlaytimeMin: gained > 0 ? estPlaytimeMin(gained) : 0,
    };
    this.settings.lastLevel = level;
    saveSettings(this.device.sd, this.settings);

    this.setScreen("boot");
    this.timerMs = BOOT_SPLASH_MS;
  }

  /** Power-off: stop any game and reset, recording the charge level. */
  shutdown(): void {
    this.booted = false;
    this.settings.lastLevel = this.device.power.getSnapshot().level;
    this.settings.lastPlayedAt = Date.now();
    saveSettings(this.device.sd, this.settings);
    this.dispose();
    this.currentGame = null;
    this.setScreen("boot");
    // Power-off blanks the display. (Light/deep-sleep never call shutdown, so
    // the bistable memory LCD holds its last frame while sleeping.)
    this.gfx.clear();
  }

  /** Return to the game selector (stopping a running game). */
  returnToMenu(): void {
    if (!this.booted) return;
    if (this.screen === "game") this.exitGame();
    else this.setScreen("menu");
  }

  /** Dev shortcut: launch an arbitrary script path as a game, bypassing the menu. */
  async launchScript(path: string): Promise<void> {
    // Mark booted first so powering on does not also trigger a full boot()
    // (which would re-scan and overwrite the charge baseline mid-session).
    this.booted = true;
    if (!this.device.poweredOn) this.device.powerOn();
    await this.launch({
      id: path,
      path,
      mainPath: path,
      title: basename(path),
    });
  }

  /** Free the owned Lua engine, without the power-off settings side effects. */
  dispose(): void {
    void this.runtime.dispose();
  }

  update(dtSeconds: number): void {
    if (!this.booted) return;
    const dtMs = dtSeconds * 1000;
    const gp = this.device.gamepad;
    // A held button counts as activity too, so the device doesn't light-sleep
    // while the user is holding a direction.
    const active = ALL_BUTTONS.some((b) => gp.wasPressed(b) || gp.isDown(b));
    this.idleMs = active ? 0 : this.idleMs + dtMs;

    switch (this.screen) {
      case "boot":
        this.timerMs -= dtMs;
        if (this.timerMs <= 0) this.finishBoot();
        break;
      case "countdown":
        if (gp.wasPressed(Button.A)) void this.launchSelected();
        else if (gp.wasPressed(Button.B)) this.setScreen("menu");
        else {
          this.timerMs -= dtMs;
          if (this.timerMs <= 0) void this.launchSelected();
        }
        break;
      case "menu":
        this.updateMenu();
        break;
      case "settings":
        this.updateSettings();
        break;
      case "game":
        if (gp.wasPressed(Button.Menu)) this.exitGame();
        else this.runtime.update(dtSeconds);
        break;
    }

    this.updatePowerMode();
  }

  draw(): void {
    if (!this.booted) return;
    switch (this.screen) {
      case "boot":
        this.drawBoot();
        break;
      case "countdown":
        this.drawCountdown();
        break;
      case "menu":
        this.drawMenu();
        break;
      case "settings":
        this.drawSettings();
        break;
      case "game":
        this.runtime.draw();
        if (this.error) this.drawGameError();
        break;
    }
  }

  // ---- state transitions ----------------------------------------------

  private finishBoot(): void {
    if (this.games.length === 1) {
      this.selected = 0;
      this.timerMs = COUNTDOWN_MS;
      this.setScreen("countdown");
    } else {
      this.setScreen("menu");
    }
  }

  private updateMenu(): void {
    const gp = this.device.gamepad;
    if (this.games.length > 0) {
      if (gp.wasPressed(Button.Down)) this.moveSelection(1);
      if (gp.wasPressed(Button.Up)) this.moveSelection(-1);
      if (gp.wasPressed(Button.A)) void this.launchSelected();
    }
    if (gp.wasPressed(Button.Menu)) {
      this.settingsSel = 0;
      this.setScreen("settings");
    }
  }

  private updateSettings(): void {
    const gp = this.device.gamepad;
    const itemCount = WIFI_SLOTS + 1; // wifi slots + Back
    if (gp.wasPressed(Button.Down))
      this.settingsSel = (this.settingsSel + 1) % itemCount;
    if (gp.wasPressed(Button.Up))
      this.settingsSel = (this.settingsSel + itemCount - 1) % itemCount;
    if (gp.wasPressed(Button.A)) {
      if (this.settingsSel < WIFI_SLOTS) this.toggleWifi(this.settingsSel);
      else this.setScreen("menu"); // Back
    }
    if (gp.wasPressed(Button.B)) this.setScreen("menu");
  }

  private moveSelection(delta: number): void {
    const n = this.games.length;
    this.selected = (this.selected + delta + n) % n;
    this.emit();
  }

  private toggleWifi(slot: number): void {
    // Placeholder configuration: cycle a demo SSID on/off and persist it.
    const wifi = [...this.settings.wifi];
    while (wifi.length < WIFI_SLOTS) wifi.push({ ssid: "" });
    const current = wifi[slot]?.ssid ?? "";
    wifi[slot] = { ssid: current ? "" : `Flywheel-${slot + 1}` };
    this.settings = { ...this.settings, wifi };
    saveSettings(this.device.sd, this.settings);
    this.emit();
  }

  private async launchSelected(): Promise<void> {
    const game = this.games[this.selected];
    if (game) await this.launch(game);
    else this.setScreen("menu");
  }

  private async launch(game: GameEntry): Promise<void> {
    this.currentGame = game;
    this.error = null;
    this.device.power.setEspMode(EspMode.Active);
    this.setScreen("game");
    try {
      await this.runtime.load(this.device.sd.readTextFileSync(game.mainPath));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  private exitGame(): void {
    void this.runtime.dispose();
    this.currentGame = null;
    this.error = null;
    this.idleMs = 0;
    this.setScreen("menu");
  }

  private updatePowerMode(): void {
    // Idle in a menu drops to light-sleep to save power; games stay active.
    const inMenu = this.screen === "menu" || this.screen === "settings";
    const mode =
      inMenu && this.idleMs >= IDLE_SLEEP_MS
        ? EspMode.LightSleep
        : EspMode.Active;
    this.device.power.setEspMode(mode);
  }

  private setScreen(screen: BiosScreen): void {
    if (this.screen === screen) return;
    this.screen = screen;
    this.idleMs = 0;
    this.emit();
  }

  private emit(): void {
    this.events.emit("change", this.snapshot());
  }

  // ---- rendering -------------------------------------------------------

  private drawBoot(): void {
    const g = this.gfx;
    g.clear();
    centerText(g, "FLYWHEEL", 86);
    centerText(g, `FW-01  SOLAR  v${FIRMWARE_VERSION}`, 104);

    const report = this.chargeReport;
    if (report && report.gainedLevel > 0.005) {
      const pct = Math.round(report.gainedLevel * 100);
      centerText(
        g,
        `+${pct}% since last  (~${report.estPlaytimeMin} min)`,
        140,
      );
    }
    centerText(g, "booting...", H - 24);
  }

  private drawCountdown(): void {
    const g = this.gfx;
    const game = this.games[this.selected];
    g.clear();
    centerText(g, "LOADING", 70);
    centerText(g, truncate((game?.title ?? "").toUpperCase(), 40), 92);
    const secs = Math.ceil(this.timerMs / 1000);
    centerText(g, `Starting in ${secs}...`, 120);
    centerText(g, "A START    B CANCEL", H - 28);
  }

  private drawMenu(): void {
    const g = this.gfx;
    g.clear();
    this.drawTitleBar("GAMES");

    if (this.games.length === 0) {
      centerText(g, "No games on SD card", 120);
    } else {
      const rowH = 30;
      const top = 34;
      const visible = Math.floor((H - top - 24) / rowH);
      const first = clamp(
        this.selected - Math.floor(visible / 2),
        0,
        Math.max(0, this.games.length - visible),
      );
      for (let i = 0; i < visible && first + i < this.games.length; i++) {
        const idx = first + i;
        const y = top + i * rowH;
        const game = this.games[idx];
        const sel = idx === this.selected;
        if (sel) g.rectFill(6, y, W - 12, rowH - 4, true);
        drawIcon(g, 12, y + 2, 22, game.title, sel);
        g.print(truncate(game.title, 48), 42, y + 9, !sel);
      }
    }
    this.drawFooter("A LOAD    MENU = SETTINGS");
  }

  private drawSettings(): void {
    const g = this.gfx;
    g.clear();
    this.drawTitleBar("SETTINGS");

    const rows: string[] = [];
    for (let i = 0; i < WIFI_SLOTS; i++) {
      const ssid = this.settings.wifi[i]?.ssid;
      rows.push(`Wi-Fi ${i + 1}:  ${ssid ? ssid : "-"}`);
    }
    rows.push("Back");

    const top = 40;
    const rowH = 24;
    for (let i = 0; i < rows.length; i++) {
      const y = top + i * rowH;
      const sel = i === this.settingsSel;
      if (sel) g.rectFill(6, y - 4, W - 12, rowH - 2, true);
      g.print(rows[i], 14, y, !sel);
    }

    const pct = Math.round(this.device.power.getSnapshot().level * 100);
    g.print(`Battery: ${pct}%`, 14, top + rows.length * rowH + 8, true);
    this.drawFooter("A SELECT    B BACK");
  }

  private drawGameError(): void {
    const g = this.gfx;
    // Start clean: a failed load may leave the previous screen's frame behind.
    g.clear();
    g.rect(40, 90, W - 80, 60, true);
    g.print("SCRIPT ERROR", 52, 100, true);
    const msg = (this.error ?? "").replace(/\s+/g, " ");
    g.print(truncate(msg, 44), 52, 114, true);
    g.print("MENU = EXIT", 52, 132, true);
  }

  private drawTitleBar(label: string): void {
    const g = this.gfx;
    g.rectFill(0, 0, W, 22, true);
    g.print(label, 8, 8, false);
    this.drawBattery(W - 40, 6);
  }

  private drawFooter(hint: string): void {
    const g = this.gfx;
    g.print(hint, 8, H - 14, true);
  }

  private drawBattery(x: number, y: number): void {
    const g = this.gfx;
    const level = this.device.power.getSnapshot().level;
    const bw = 26;
    const bh = 11;
    // Drawn inverted (on the dark title bar): false = light ink.
    g.rect(x, y, bw, bh, false);
    g.rectFill(x + bw, y + 3, 2, bh - 6, false);
    const fill = Math.round((bw - 4) * clamp(level, 0, 1));
    if (fill > 0) g.rectFill(x + 2, y + 2, fill, bh - 4, false);
  }
}

// ---- helpers -----------------------------------------------------------

function estPlaytimeMin(gainedLevel: number): number {
  const gainedMah = gainedLevel * POWER_CONSTANTS.capacityMah;
  const activeDrawMa =
    POWER_CONSTANTS.baseDrawMa[EspMode.Active] +
    POWER_CONSTANTS.consumerDrawMa[PowerConsumer.Display];
  return Math.round((gainedMah / activeDrawMa) * 60);
}

function centerText(g: Graphics, text: string, y: number): void {
  g.print(text, Math.round((W - g.textWidth(text)) / 2), y, true);
}

function drawIcon(
  g: Graphics,
  x: number,
  y: number,
  size: number,
  title: string,
  inverted: boolean,
): void {
  const ink = !inverted;
  g.rect(x, y, size, size, ink);
  const letter = (title.trim()[0] ?? "?").toUpperCase();
  g.print(
    letter,
    x + Math.round((size - 6) / 2),
    y + Math.round((size - 7) / 2),
    ink,
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 3)) + "..." : s;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
