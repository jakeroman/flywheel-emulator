import type { SyncSDAccess } from "../hal/sd.js";

export interface WifiSlot {
  ssid: string;
}

export interface BiosSettings {
  /** Up to 3 saved Wi-Fi networks. */
  wifi: WifiSlot[];
  /** Battery level (0..1) recorded at the last boot, for charge comparison. */
  lastLevel: number;
  /** When the last session ended (ms epoch), informational. */
  lastPlayedAt: number;
}

export const WIFI_SLOTS = 3;
const SETTINGS_PATH = "/system/settings.json";

const DEFAULTS: BiosSettings = { wifi: [], lastLevel: 0, lastPlayedAt: 0 };

export function loadSettings(sd: SyncSDAccess): BiosSettings {
  try {
    if (sd.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(sd.readTextFileSync(SETTINGS_PATH)) as Record<
        string,
        unknown
      >;
      // Validate each field — settings.json is on the (user-importable) SD card,
      // so a malformed entry must not poison boot math or crash the settings UI.
      return {
        wifi: Array.isArray(raw.wifi)
          ? raw.wifi.slice(0, WIFI_SLOTS).map((w) => ({ ssid: readSsid(w) }))
          : [],
        lastLevel: numberOr(raw.lastLevel, 0),
        lastPlayedAt: numberOr(raw.lastPlayedAt, 0),
      };
    }
  } catch {
    // Corrupt/unreadable settings — fall back to defaults.
  }
  return { ...DEFAULTS };
}

function readSsid(entry: unknown): string {
  if (typeof entry === "object" && entry !== null) {
    const ssid = (entry as { ssid?: unknown }).ssid;
    if (typeof ssid === "string") return ssid;
  }
  return "";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function saveSettings(sd: SyncSDAccess, settings: BiosSettings): void {
  try {
    sd.mkdirSync("/system", true);
    sd.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // Best-effort; persistence failures shouldn't crash the BIOS.
  }
}
