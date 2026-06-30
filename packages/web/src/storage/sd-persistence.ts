import {
  SEED_VERSION,
  seedMockContent,
  type MemorySDCard,
  type SDEntry,
} from "@flywheel/emulator-core";
import { idbGet, idbSet } from "./idb.js";

const SNAPSHOT_KEY = "sd-snapshot";
const SEED_VERSION_KEY = "seed-version";

/**
 * Bring the SD card up: load the persisted snapshot, and (re-)seed the bundled
 * default content if nothing is stored yet or the seed version has changed.
 * Re-seeding only writes the default game paths, so a user's own files survive.
 */
export async function ensureSeeded(sd: MemorySDCard): Promise<void> {
  const loaded = await loadFromIndexedDb(sd).catch(() => false);
  const storedVersion = await idbGet<number>(SEED_VERSION_KEY).catch(
    () => undefined,
  );
  if (!loaded || storedVersion !== SEED_VERSION) {
    await seedMockContent(sd);
    await saveToIndexedDb(sd).catch(() => {});
    await idbSet(SEED_VERSION_KEY, SEED_VERSION).catch(() => {});
  }
}

/**
 * Load the resident SD card from IndexedDB. Returns false if nothing is stored
 * yet (so the caller can seed initial content). Uint8Array data is stored
 * natively via structured clone.
 */
export async function loadFromIndexedDb(sd: MemorySDCard): Promise<boolean> {
  const entries = await idbGet<SDEntry[]>(SNAPSHOT_KEY);
  if (!entries || entries.length === 0) return false;
  sd.clear();
  sd.importEntries(entries);
  return true;
}

export async function saveToIndexedDb(sd: MemorySDCard): Promise<void> {
  await idbSet(SNAPSHOT_KEY, sd.exportEntries());
}

/* ---- Portable file archive (download / upload) ----------------------- */

interface SdArchive {
  v: 1;
  entries: Array<{ path: string; type: "file" | "dir"; data?: string }>;
}

/** Serialize the whole filesystem to a downloadable JSON blob (base64 data). */
export function exportToBlob(sd: MemorySDCard): Blob {
  const archive: SdArchive = {
    v: 1,
    entries: sd
      .exportEntries()
      .map((e) =>
        e.type === "file"
          ? { path: e.path, type: e.type, data: bytesToBase64(e.data) }
          : { path: e.path, type: e.type },
      ),
  };
  return new Blob([JSON.stringify(archive)], { type: "application/json" });
}

/** Replace the filesystem with the contents of a previously-exported archive. */
export function importFromText(sd: MemorySDCard, text: string): void {
  const archive = JSON.parse(text) as SdArchive;
  if (archive.v !== 1 || !Array.isArray(archive.entries)) {
    throw new Error("Unrecognized SD archive");
  }
  const entries: SDEntry[] = archive.entries.map((e) => ({
    path: e.path,
    type: e.type,
    data:
      e.type === "file" && e.data ? base64ToBytes(e.data) : new Uint8Array(0),
  }));
  sd.clear();
  sd.importEntries(entries);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
