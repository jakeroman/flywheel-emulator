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
      const raw = JSON.parse(
        sd.readTextFileSync(SETTINGS_PATH),
      ) as Partial<BiosSettings>;
      return {
        ...DEFAULTS,
        ...raw,
        wifi: Array.isArray(raw.wifi) ? raw.wifi.slice(0, WIFI_SLOTS) : [],
      };
    }
  } catch {
    // Corrupt/unreadable settings — fall back to defaults.
  }
  return { ...DEFAULTS };
}

export function saveSettings(sd: SyncSDAccess, settings: BiosSettings): void {
  try {
    sd.mkdirSync("/system", true);
    sd.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // Best-effort; persistence failures shouldn't crash the BIOS.
  }
}
