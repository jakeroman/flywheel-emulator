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
const MAX_TITLE_LEN = 40;

/**
 * Scan /games for runnable games. A game is any direct subdirectory containing
 * a main.lua. The title comes from an optional meta.lua (`return { title=... }`,
 * read with a forgiving regex so scanning needs no Lua VM); otherwise the
 * folder name is used.
 */
export function scanGames(sd: SyncSDAccess): GameEntry[] {
  if (!sd.existsSync(GAMES_DIR)) return [];
  const games: GameEntry[] = [];
  for (const entry of sd.readDirSync(GAMES_DIR)) {
    if (entry.type !== "dir") continue;
    const mainPath = `${entry.path}/main.lua`;
    if (!sd.existsSync(mainPath)) continue;
    games.push({
      id: entry.name,
      path: entry.path,
      mainPath,
      title: readTitle(sd, entry.path, entry.name),
    });
  }
  games.sort((a, b) => a.title.localeCompare(b.title));
  return games;
}

function readTitle(sd: SyncSDAccess, dir: string, fallback: string): string {
  const metaPath = `${dir}/meta.lua`;
  if (!sd.existsSync(metaPath)) return fallback;
  try {
    const match = sd
      .readTextFileSync(metaPath)
      .match(/title\s*=\s*["']([^"']+)["']/);
    if (!match) return fallback;
    const title = sanitizeTitle(match[1]);
    return title || fallback;
  } catch {
    return fallback;
  }
}

/** Collapse control chars/whitespace and clamp, so a long or hostile title
 *  can't corrupt the selector layout. */
function sanitizeTitle(raw: string): string {
  let out = "";
  for (const ch of raw) {
    out += ch.charCodeAt(0) < 0x20 ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
}
