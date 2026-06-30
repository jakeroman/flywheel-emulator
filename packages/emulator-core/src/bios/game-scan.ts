import type { SyncSDAccess } from "../hal/sd.js";

/** A game discovered on the SD card: a /games/<id>/ folder with a main.lua. */
export interface GameEntry {
  /** Folder name, e.g. "snake". */
  id: string;
  /** Folder path, e.g. "/games/snake". */
  path: string;
  /** Entry script, e.g. "/games/snake/main.lua". */
  mainPath: string;
  /** Display title from meta.lua, falling back to the folder name. */
  title: string;
}

export const GAMES_DIR = "/games";
export const MAX_TITLE_LEN = 40;
/** Optional per-game manifest filename (see manifest.ts). Defined here, the
 *  leaf module, so the manifest resolver can import it without a cycle. */
export const MANIFEST_FILE = "game.json";

/**
 * Scan /games for runnable games. A game is any direct subdirectory containing
 * a main.lua OR a game.json manifest (which may declare a different entry
 * script — resolveGame() picks the real entry at launch). The title comes from
 * an optional meta.lua (`return { title=... }`, read with a forgiving regex so
 * scanning needs no Lua VM); otherwise the folder name is used. Full manifest
 * parsing happens later, at launch — scanning stays cheap and dependency-free.
 */
export function scanGames(sd: SyncSDAccess): GameEntry[] {
  if (!sd.existsSync(GAMES_DIR)) return [];
  const games: GameEntry[] = [];
  for (const entry of sd.readDirSync(GAMES_DIR)) {
    if (entry.type !== "dir") continue;
    const mainPath = `${entry.path}/main.lua`;
    if (
      !sd.existsSync(mainPath) &&
      !sd.existsSync(`${entry.path}/${MANIFEST_FILE}`)
    ) {
      continue;
    }
    games.push({
      id: entry.name,
      path: entry.path,
      mainPath,
      title: readMetaTitle(sd, entry.path) ?? entry.name,
    });
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  return games;
}

/**
 * Read a sanitized title from a game dir's optional meta.lua, or null if there
 * is no usable title. Shared with the manifest resolver.
 */
export function readMetaTitle(sd: SyncSDAccess, dir: string): string | null {
  const metaPath = `${dir}/meta.lua`;
  if (!sd.existsSync(metaPath)) return null;
  try {
    const match = sd
      .readTextFileSync(metaPath)
      .match(/title\s*=\s*["']([^"']+)["']/);
    if (!match) return null;
    return sanitizeTitle(match[1]) || null;
  } catch {
    return null;
  }
}

/** Collapse control chars/whitespace and clamp, so a long or hostile title
 *  can't corrupt the selector layout. */
export function sanitizeTitle(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += ch.charCodeAt(0) < 0x20 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
}
