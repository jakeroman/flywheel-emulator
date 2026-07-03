/**
 * Per-game save store — the data behind `fw.save`.
 *
 * A game persists data without knowing its own location on the SD card: the
 * BIOS hands each game a save directory (`/saves/<id>`), and this store keeps a
 * single JSON document there (`save.json`) holding a flat map of keys to
 * JSON-serializable values (numbers, strings, booleans, and tables thereof).
 *
 * Why one document instead of a file per key:
 *   - The `key` is a map key, never a path, so a game can't traverse the
 *     filesystem via `fw.save.set("../../system/settings", ...)`.
 *   - A whole save is one atomic write, and one read seeds the in-memory cache.
 *
 * On real hardware the same firmware computes the same `/saves/<id>` path and
 * the same file ops hit the mounted SD — this is ordinary file access, scoped.
 */

/** The subset of the SD card the save store needs (resident, synchronous). */
export interface SaveStoreSD {
  existsSync(path: string): boolean;
  readTextFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, recursive?: boolean): void;
  removeSync(path: string): void;
}

/** The `fw.save` table injected into a Lua game. */
export interface SaveApi {
  /** Absolute save directory for this game, e.g. "/saves/snake". */
  readonly dir: string;
  /** Read a saved value, or `dflt` (default nil) if the key is unset. */
  get(key: unknown, dflt?: unknown): unknown;
  /** Persist a JSON-serializable value under `key` (writes through to SD).
   *  Passing nil (or a non-finite number) clears the key, per Lua semantics. */
  set(key: unknown, value: unknown): void;
  /** Whether `key` has a saved value. */
  has(key: unknown): boolean;
  /** Remove one key (writes through). */
  delete(key: unknown): void;
  /** The keys currently saved. */
  keys(): string[];
  /** Erase this game's entire save (removes save.json). */
  clear(): void;
}

type Doc = Record<string, unknown>;

/**
 * Reduce a value to something JSON can round-trip, or throw a clear error.
 * Returns `null` for values that have no storable representation — Lua `nil`
 * (JS undefined/null) and non-finite numbers — which set() treats as "clear the
 * key" (the Lua table idiom `t[k] = nil`). Functions, symbols, and bigints are
 * rejected with a message the game author will see. Nested nulls inside a table
 * are preserved (they round-trip through JSON as part of the object value).
 */
function toStorable(value: unknown, key: string): unknown {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? value : null;
  if (t === "string" || t === "boolean") return value;
  if (t === "object") {
    try {
      return JSON.parse(JSON.stringify(value)) as unknown;
    } catch {
      throw new Error(`fw.save.set: value for "${key}" is not serializable`);
    }
  }
  throw new Error(`fw.save.set: cannot save a ${t} for "${key}"`);
}

/** Deep-copy a stored value so a game can't mutate the in-memory cache. */
function clone(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/**
 * Build a save API bound to one game's save directory. Loading is lazy (the
 * document is read on first access and cached); a corrupt or missing save.json
 * degrades to an empty store rather than crashing the game.
 */
export function createSaveApi(sd: SaveStoreSD, dir: string): SaveApi {
  const file = `${dir}/save.json`;
  let cache: Doc | null = null;

  // A null-prototype doc so keys like "__proto__" / "constructor" are ordinary
  // own properties (a plain {} would route doc["__proto__"] = v to the prototype
  // setter instead of storing it) — set/get/has stay consistent for any key.
  const load = (): Doc => {
    if (cache) return cache;
    cache = Object.create(null) as Doc;
    try {
      if (sd.existsSync(file)) {
        const parsed: unknown = JSON.parse(sd.readTextFileSync(file));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(cache, parsed);
        }
      }
    } catch {
      cache = Object.create(null) as Doc; // unreadable / corrupt → start fresh
    }
    return cache;
  };

  const persist = (): void => {
    sd.mkdirSync(dir, true);
    sd.writeFileSync(file, JSON.stringify(load()));
  };

  // Persist after a single-key mutation, rolling the cache back if the SD write
  // fails — so the in-memory store never diverges from disk ("one atomic write").
  // A game can provoke a failure, e.g. fw.fs.write() a file over its own /saves
  // dir so the next set() hits mkdir EEXIST.
  const commit = (doc: Doc, k: string, had: boolean, prev: unknown): void => {
    try {
      persist();
    } catch (e) {
      if (had) doc[k] = prev;
      else delete doc[k];
      throw e;
    }
  };

  const has = (key: unknown): boolean =>
    Object.prototype.hasOwnProperty.call(load(), String(key));

  const hasKey = (doc: Doc, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(doc, k);

  return {
    dir,
    get(key: unknown, dflt?: unknown): unknown {
      const doc = load();
      const k = String(key);
      const v = hasKey(doc, k) ? doc[k] : undefined;
      // Return `dflt` (undefined when the game passes none) for a missing key —
      // NOT JS null, which wasmoon's injectObjects marshals to a truthy `null`
      // userdata, breaking the `== nil` idiom. `v == null` also covers a null
      // that slipped into a hand-edited save.json.
      return v == null ? dflt : clone(v);
    },
    set(key: unknown, value: unknown): void {
      const doc = load();
      const k = String(key);
      const had = hasKey(doc, k);
      const prev = had ? doc[k] : undefined;
      // toStorable throws (for a function/etc.) before we mutate. A null result
      // means "no storable value" (nil / non-finite) → clear the key.
      const stored = toStorable(value, k);
      if (stored === null) {
        if (!had) return; // clearing an absent key is a no-op
        delete doc[k];
      } else {
        doc[k] = stored;
      }
      commit(doc, k, had, prev);
    },
    has,
    delete(key: unknown): void {
      const doc = load();
      const k = String(key);
      if (!hasKey(doc, k)) return;
      const prev = doc[k];
      delete doc[k];
      commit(doc, k, true, prev);
    },
    keys(): string[] {
      return Object.keys(load());
    },
    clear(): void {
      cache = Object.create(null) as Doc;
      try {
        sd.removeSync(file);
      } catch {
        // Nothing saved yet — clearing an empty store is a no-op.
      }
    },
  };
}
