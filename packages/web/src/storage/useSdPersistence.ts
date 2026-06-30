import { useEffect } from "react";
import {
  seedMockContent,
  type EmulatedFlywheelDevice,
} from "@flywheel/emulator-core";
import { loadFromIndexedDb, saveToIndexedDb } from "./sd-persistence.js";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Loads the SD card from IndexedDB on mount (seeding mock content the first
 * time), then debounce-saves it back on every mutation so edits survive a
 * reload.
 */
export function useSdPersistence(device: EmulatedFlywheelDevice): void {
  useEffect(() => {
    let alive = true;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      const loaded = await loadFromIndexedDb(device.sd).catch(() => false);
      if (!alive) return;
      if (!loaded) {
        await seedMockContent(device.sd);
        await saveToIndexedDb(device.sd).catch(() => {});
      }
    })();

    const scheduleSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        void saveToIndexedDb(device.sd).catch(() => {});
      }, SAVE_DEBOUNCE_MS);
    };

    const off = device.sd.events.on("change", scheduleSave);
    return () => {
      alive = false;
      off();
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [device]);
}
