import type { SyncSDAccess } from "../hal/sd.js";
import { MANIFEST_FILE, readMetaTitle, sanitizeTitle } from "./game-scan.js";

/**
 * Game manifest + resolver.
 *
 * A game directory may carry an optional `game.json` describing its entry
 * script and any native (.fwmod) modules. `resolveGame` turns a directory into
 * a single ResolvedGame that the launch pipeline consumes — whether the game
 * has a manifest or is a bare legacy `main.lua`. This is the one place that
 * answers "what does it take to start this game?", shared by the BIOS launcher,
 * the editor Run button, and (Phase 5) native-module execution.
 *
 * game.json (all paths relative to the game dir, no traversal):
 *   {
 *     "title": "Snake",
 *     "entry": "main.lua",
 *     "modules": [ { "name": "physics", "path": "physics.fwmod" } ]
 *   }
 */

export { MANIFEST_FILE };
const MAX_MODULES = 32;
const MAX_NAME_LEN = 48;

export interface ResolvedModule {
  /** Logical name (from the manifest, or the file's basename). */
  name: string;
  /** Absolute SD path to the .fwmod, e.g. "/games/snake/physics.fwmod". */
  path: string;
}

export interface ResolvedGame {
  id: string;
  /** Game directory, e.g. "/games/snake". */
  dir: string;
  title: string;
  /** Absolute SD path to the entry Lua script. */
  entryPath: string;
  /** Native modules declared in the manifest (may be empty). */
  modules: ResolvedModule[];
  /** How the game was resolved. */
  source: "game.json" | "scan";
  /** Non-fatal problems found while resolving (malformed manifest, etc.). */
  warnings: string[];
}

/**
 * Resolve a game directory to a launchable description. Never throws: a missing
 * or malformed game.json degrades to the legacy `main.lua` convention with a
 * warning, so a bad manifest can't brick the launcher.
 */
export function resolveGame(
  sd: SyncSDAccess,
  dir: string,
  fallbackId: string,
): ResolvedGame {
  const warnings: string[] = [];
  const metaTitle = readMetaTitle(sd, dir);
  const fallback = (): ResolvedGame => ({
    id: fallbackId,
    dir,
    title: metaTitle ?? fallbackId,
    entryPath: `${dir}/main.lua`,
    modules: [],
    source: "scan",
    warnings,
  });

  const manifestPath = `${dir}/${MANIFEST_FILE}`;
  if (!sd.existsSync(manifestPath)) return fallback();

  let raw: unknown;
  try {
    raw = JSON.parse(sd.readTextFileSync(manifestPath));
  } catch (e) {
    warnings.push(
      `${MANIFEST_FILE}: ${e instanceof Error ? e.message : String(e)}; using main.lua`,
    );
    return fallback();
  }
  if (typeof raw !== "object" || raw === null) {
    warnings.push(`${MANIFEST_FILE}: not an object; using main.lua`);
    return fallback();
  }

  const obj = raw as Record<string, unknown>;

  // Entry script: relative path within the dir; defaults to main.lua.
  const entryRel = typeof obj.entry === "string" ? obj.entry : "main.lua";
  let entryPath = joinGameRelative(dir, entryRel);
  if (entryPath === null) {
    warnings.push(`${MANIFEST_FILE}: invalid entry "${entryRel}"; using main.lua`);
    entryPath = `${dir}/main.lua`;
  }

  const title =
    (typeof obj.title === "string" ? sanitizeTitle(obj.title) : "") ||
    metaTitle ||
    fallbackId;

  const modules: ResolvedModule[] = [];
  if (obj.modules !== undefined) {
    if (!Array.isArray(obj.modules)) {
      warnings.push(`${MANIFEST_FILE}: "modules" is not an array; ignoring it`);
    } else {
      const seen = new Set<string>();
      for (const m of obj.modules) {
        if (modules.length >= MAX_MODULES) {
          warnings.push(`${MANIFEST_FILE}: too many modules (max ${MAX_MODULES})`);
          break;
        }
        const resolved = resolveModule(dir, m, warnings);
        if (!resolved) continue;
        if (seen.has(resolved.path)) {
          warnings.push(
            `${MANIFEST_FILE}: duplicate module path "${resolved.path}"; skipped`,
          );
          continue;
        }
        seen.add(resolved.path);
        modules.push(resolved);
      }
    }
  }

  return { id: fallbackId, dir, title, entryPath, modules, source: "game.json", warnings };
}

function resolveModule(
  dir: string,
  m: unknown,
  warnings: string[],
): ResolvedModule | null {
  if (typeof m !== "object" || m === null) {
    warnings.push(`${MANIFEST_FILE}: module entry is not an object; skipped`);
    return null;
  }
  const entry = m as Record<string, unknown>;
  const rel = entry.path;
  if (typeof rel !== "string") {
    warnings.push(`${MANIFEST_FILE}: module missing a string "path"; skipped`);
    return null;
  }
  const path = joinGameRelative(dir, rel);
  if (path === null) {
    warnings.push(`${MANIFEST_FILE}: invalid module path "${rel}"; skipped`);
    return null;
  }
  const name =
    (typeof entry.name === "string" ? entry.name.trim().slice(0, MAX_NAME_LEN) : "") ||
    basename(path);
  return { name, path };
}

/**
 * Join a manifest-relative path onto the game dir, rejecting anything that
 * could escape it (absolute paths, "..", "." or empty segments). Returns null
 * when the input is unsafe or empty.
 */
function joinGameRelative(dir: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0) return null;
  if (rel.startsWith("/") || rel.includes("\\")) return null;
  const parts = rel.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === "..") return null;
  }
  return `${dir}/${parts.join("/")}`;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
