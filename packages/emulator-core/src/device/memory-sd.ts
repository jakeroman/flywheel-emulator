import { Emitter } from "../util/emitter.js";
import type { FileStat, SDCard, SDEvents } from "../hal/sd.js";

interface Node {
  type: "file" | "dir";
  data: Uint8Array;
  mtime: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * In-memory virtual filesystem implementing the SDCard contract. This is the
 * authoritative resident store; Phase 1 layers IndexedDB persistence and
 * import/export on top without changing this behavior.
 *
 * The core operations are synchronous (the store lives in RAM); the async
 * SDCard methods are thin delegators so the same code backs both the in-frame
 * sync view used by Lua/BIOS and the async persistence/transfer view.
 */
export class MemorySDCard implements SDCard {
  readonly events = new Emitter<SDEvents>();
  private readonly nodes = new Map<string, Node>();

  constructor() {
    this.nodes.set("/", { type: "dir", data: EMPTY, mtime: now() });
  }

  // ---- Synchronous core ------------------------------------------------

  existsSync(path: string): boolean {
    return this.nodes.has(normalize(path));
  }

  statSync(path: string): FileStat | null {
    const p = normalize(path);
    const node = this.nodes.get(p);
    return node ? toStat(p, node) : null;
  }

  readDirSync(path: string): readonly FileStat[] {
    const dir = normalize(path);
    const node = this.nodes.get(dir);
    if (!node) throw new Error(`ENOENT: ${dir}`);
    if (node.type !== "dir") throw new Error(`ENOTDIR: ${dir}`);
    const prefix = dir === "/" ? "/" : dir + "/";
    const entries: FileStat[] = [];
    for (const [p, n] of this.nodes) {
      if (p === dir) continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue; // direct children only
      entries.push(toStat(p, n));
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  mkdirSync(path: string, recursive = false): void {
    const p = normalize(path);
    if (this.nodes.has(p)) {
      if (this.nodes.get(p)!.type === "dir") return;
      throw new Error(`EEXIST: ${p}`);
    }
    const parent = dirname(p);
    const parentNode = this.nodes.get(parent);
    if (!parentNode) {
      if (!recursive) throw new Error(`ENOENT: ${parent}`);
      this.mkdirSync(parent, true);
    } else if (parentNode.type !== "dir") {
      throw new Error(`ENOTDIR: ${parent}`);
    }
    this.nodes.set(p, { type: "dir", data: EMPTY, mtime: now() });
    this.events.emit("change", { path: p });
  }

  readFileSync(path: string): Uint8Array {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new Error(`ENOENT: ${p}`);
    if (node.type !== "file") throw new Error(`EISDIR: ${p}`);
    return node.data;
  }

  readTextFileSync(path: string): string {
    return decoder.decode(this.readFileSync(path));
  }

  writeFileSync(path: string, data: Uint8Array | string): void {
    const p = normalize(path);
    const parent = dirname(p);
    const parentNode = this.nodes.get(parent);
    if (!parentNode) throw new Error(`ENOENT: ${parent}`);
    if (parentNode.type !== "dir") throw new Error(`ENOTDIR: ${parent}`);
    if (this.nodes.get(p)?.type === "dir") throw new Error(`EISDIR: ${p}`);
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.nodes.set(p, { type: "file", data: bytes, mtime: now() });
    this.events.emit("change", { path: p });
  }

  removeSync(path: string): void {
    const p = normalize(path);
    if (p === "/") throw new Error("EPERM: cannot remove root");
    if (!this.nodes.has(p)) throw new Error(`ENOENT: ${p}`);
    const prefix = p + "/";
    for (const key of [...this.nodes.keys()]) {
      if (key === p || key.startsWith(prefix)) this.nodes.delete(key);
    }
    this.events.emit("change", { path: p });
  }

  renameSync(from: string, to: string): void {
    const src = normalize(from);
    const dst = normalize(to);
    if (!this.nodes.has(src)) throw new Error(`ENOENT: ${src}`);
    if (src === "/") throw new Error("EPERM: cannot rename root");
    if (dst === src) return;
    // Refuse to move a directory into itself or its own subtree.
    if (dst.startsWith(src + "/")) {
      throw new Error(`EINVAL: cannot move ${src} into its own subtree`);
    }
    const dstParent = dirname(dst);
    const dstParentNode = this.nodes.get(dstParent);
    if (!dstParentNode) throw new Error(`ENOENT: ${dstParent}`);
    if (dstParentNode.type !== "dir") throw new Error(`ENOTDIR: ${dstParent}`);
    if (this.nodes.has(dst)) throw new Error(`EEXIST: ${dst}`);

    const srcPrefix = src + "/";
    const moves: Array<[string, string]> = [];
    for (const key of this.nodes.keys()) {
      if (key === src) moves.push([key, dst]);
      else if (key.startsWith(srcPrefix))
        moves.push([key, dst + "/" + key.slice(srcPrefix.length)]);
    }
    for (const [oldKey, newKey] of moves) {
      const node = this.nodes.get(oldKey)!;
      this.nodes.delete(oldKey);
      this.nodes.set(newKey, { ...node, mtime: now() });
    }
    this.events.emit("change", { path: dst });
  }

  // ---- Async persistence/transfer view (delegates to the sync core) ----

  async exists(path: string): Promise<boolean> {
    return this.existsSync(path);
  }
  async stat(path: string): Promise<FileStat | null> {
    return this.statSync(path);
  }
  async readDir(path: string): Promise<readonly FileStat[]> {
    return this.readDirSync(path);
  }
  async mkdir(path: string, recursive = false): Promise<void> {
    this.mkdirSync(path, recursive);
  }
  async readFile(path: string): Promise<Uint8Array> {
    return this.readFileSync(path);
  }
  async readTextFile(path: string): Promise<string> {
    return this.readTextFileSync(path);
  }
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    this.writeFileSync(path, data);
  }
  async remove(path: string): Promise<void> {
    this.removeSync(path);
  }
  async rename(from: string, to: string): Promise<void> {
    this.renameSync(from, to);
  }

  /** Snapshot every entry (for export / persistence). Buffers are copied so
   * the snapshot is independent of later writes to the resident store. */
  exportEntries(): SDEntry[] {
    const out: SDEntry[] = [];
    for (const [path, node] of this.nodes) {
      if (path === "/") continue;
      out.push({ path, type: node.type, data: node.data.slice() });
    }
    return out;
  }

  /** Reset to an empty filesystem (just the root directory). */
  clear(): void {
    this.nodes.clear();
    this.nodes.set("/", { type: "dir", data: EMPTY, mtime: now() });
    this.events.emit("change", { path: "/" });
  }

  /** Load a set of entries (creating any missing parent directories). */
  importEntries(entries: readonly SDEntry[]): void {
    const dirs = entries
      .filter((e) => e.type === "dir")
      .sort((a, b) => a.path.length - b.path.length);
    for (const d of dirs) this.mkdirSync(d.path, true);
    for (const f of entries) {
      if (f.type === "file") {
        this.mkdirSync(dirname(f.path), true);
        this.writeFileSync(f.path, f.data);
      }
    }
    this.events.emit("change", { path: "/" });
  }
}

export interface SDEntry {
  path: string;
  type: "file" | "dir";
  data: Uint8Array;
}

/** A small but complete Lua app: a bouncing ball you can steer, with sound. */
const DEMO_LUA = `-- Flywheel Lua demo: steer the ball with the D-pad, A = beep.
local x, y = fw.width / 2, fw.height / 2
local vx, vy = 70, 52
local r = 5

function _init()
  fw.log("demo started: " .. fw.width .. "x" .. fw.height)
end

function _update(dt)
  if fw.btn(fw.LEFT) then vx = vx - 240 * dt end
  if fw.btn(fw.RIGHT) then vx = vx + 240 * dt end
  if fw.btn(fw.UP) then vy = vy - 240 * dt end
  if fw.btn(fw.DOWN) then vy = vy + 240 * dt end
  if fw.btnp(fw.A) then fw.sound.tone(660, 70) end

  x = x + vx * dt
  y = y + vy * dt
  if x < r then x, vx = r, -vx; fw.sound.tone(330, 40) end
  if x > fw.width - r then x, vx = fw.width - r, -vx; fw.sound.tone(330, 40) end
  if y < r then y, vy = r, -vy; fw.sound.tone(330, 40) end
  if y > fw.height - r then y, vy = fw.height - r, -vy; fw.sound.tone(330, 40) end
end

function _draw()
  fw.gfx.cls()
  fw.gfx.rect(0, 0, fw.width, fw.height)
  fw.gfx.circfill(x, y, r)
  fw.gfx.print("FLYWHEEL LUA DEMO", 8, 8)
  fw.gfx.print("D-PAD MOVE   A BEEP", 8, 20)
  fw.gfx.print(string.format("t=%.1f", fw.time()), 8, fw.height - 14)
end
`;

/** A complete second game: grid Snake with food, growth, and game-over. */
const SNAKE_LUA = `-- Snake: D-pad turns, eat the food, don't bite yourself. A retries.
local CELL, OX, OY, COLS, ROWS = 10, 10, 16, 37, 20
local snake, dir, food, dead, score, acc

local function place_food()
  while true do
    local fx, fy = math.random(0, COLS - 1), math.random(0, ROWS - 1)
    local clash = false
    for i = 1, #snake do
      if snake[i].x == fx and snake[i].y == fy then clash = true break end
    end
    if not clash then food = { x = fx, y = fy } return end
  end
end

local function reset()
  snake = { { x = 8, y = 10 }, { x = 7, y = 10 }, { x = 6, y = 10 } }
  dir, dead, score, acc = { x = 1, y = 0 }, false, 0, 0
  place_food()
end

function _init() reset() end

local STEP = 0.12

local function step()
  local head = snake[1]
  local nx, ny = head.x + dir.x, head.y + dir.y
  if nx < 0 or nx >= COLS or ny < 0 or ny >= ROWS then dead = true return end
  for i = 1, #snake do
    if snake[i].x == nx and snake[i].y == ny then dead = true return end
  end
  table.insert(snake, 1, { x = nx, y = ny })
  if nx == food.x and ny == food.y then
    score = score + 1
    fw.sound.tone(880, 40)
    place_food()
  else
    table.remove(snake)
  end
end

function _update(dt)
  if dead then
    if fw.btnp(fw.A) then reset() end
    return
  end
  if fw.btnp(fw.UP) and dir.y == 0 then dir = { x = 0, y = -1 } end
  if fw.btnp(fw.DOWN) and dir.y == 0 then dir = { x = 0, y = 1 } end
  if fw.btnp(fw.LEFT) and dir.x == 0 then dir = { x = -1, y = 0 } end
  if fw.btnp(fw.RIGHT) and dir.x == 0 then dir = { x = 1, y = 0 } end
  acc = acc + dt
  while acc >= STEP do
    acc = acc - STEP
    step()
    if dead then fw.sound.tone(160, 220) break end
  end
end

local function cell(cx, cy)
  fw.gfx.rectfill(OX + cx * CELL, OY + cy * CELL, CELL - 1, CELL - 1)
end

function _draw()
  fw.gfx.cls()
  fw.gfx.print("SNAKE", 10, 4)
  fw.gfx.print("SCORE " .. score, fw.width - 72, 4)
  fw.gfx.rect(OX - 2, OY - 2, COLS * CELL + 3, ROWS * CELL + 3)
  for i = 1, #snake do cell(snake[i].x, snake[i].y) end
  fw.gfx.rectfill(OX + food.x * CELL + 2, OY + food.y * CELL + 2, CELL - 5, CELL - 5)
  if dead then
    fw.gfx.rectfill(135, 100, 130, 38, false)
    fw.gfx.rect(135, 100, 130, 38)
    fw.gfx.print("GAME OVER", 162, 110)
    fw.gfx.print("A = RETRY", 164, 122)
  end
end
`;

/**
 * A Lua game whose whole visual is produced by a C accelerator: it allocates a
 * full-screen buffer, and each frame calls render() (from ripple.fwmod) to fill
 * all 96000 pixels, then blits the result. The per-pixel work runs in C.
 */
const RIPPLE_LUA = `-- Ripple: a full-screen effect rendered by a C accelerator.
-- render() lives in ripple.c (compiled to ripple.fwmod); Lua just drives it.
local fx = fw.native.fx
local W, H = fw.width, fw.height
local buf
local t = 0
function _init()
  buf = fx.alloc(W * H)
end
function _update(dt)
  t = t + 2
  if fw.btnp(fw.A) then t = 0 end
end
function _draw()
  fx.render(buf, W, H, t)
  fw.gfx.blit(buf, 0, 0, W, H)
end
`;

const RIPPLE_GAME_JSON =
  '{ "title": "Ripple (C)", "entry": "main.lua",\n' +
  '  "modules": [{ "name": "fx", "path": "ripple.fwmod" }] }\n';

// ripple.fwmod — examples/ripple.c compiled with clang --target=wasm32 by the
// fwmod CLI, base64-embedded so the seed can ship a real native helper on the
// SD. Rebuild: python -m fwmod build examples/ripple.c --arch wasm32 --cc <clang>
// -o fixtures/ripple-wasm32.fwmod, then re-encode.
const RIPPLE_FWMOD_B64 =
  "RldNRAEAAQAEAAAA4wIAAAAAAAAAAAAAAAAAABQw+OoAYXNtAQAAAAEVBGABfwF/YAAAYAF9AGAEf39/fwF/AwYFAAECAQMEBQFwAQUFBQMBAAIGCAF/AUGAgAQLBzADBm1lbW9yeQIAB2Z3X21haW4AABlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQAJCgEAQQELBAECAwQKxQEFCABBgICEgAALAgALAgALAgALsAEBCn8gAkF+bSEEIAFBfm0hBQJAIAJBAUgNAEEAIQYgAUEBSCEHIAMhCANAAkAgBw0AIAYgBGoiCSAJbCEKIAghCyAFIQkgACEMIAEhDQNAIAwgCSAJbCAKakEGdiADa0EDdiALQQR2c0EBcToAACALQQFqIQsgCUEBaiEJIAxBAWohDCANQX9qIg0NAAsLIAhBAWohCCAAIAFqIQAgBkEBaiIGIAJHDQALCyACIAFsCwsvAQBBgIAECycBAAAAAgAAAAMAAAAQAAEAIAABAAQAAAAAAAAAAAAAAHJlbmRlcgAAXgRuYW1lAAwLbW9kdWxlLndhc20BKQUACl9fZndfZW50cnkBBGluaXQCBnVwZGF0ZQMEZHJhdwQGcmVuZGVyBxIBAA9fX3N0YWNrX3BvaW50ZXIJCgEABy5yb2RhdGEAdglwcm9kdWNlcnMBDHByb2Nlc3NlZC1ieQEFY2xhbmdWMjIuMS44IChodHRwczovL2dpdGh1Yi5jb20vbGx2bS9sbHZtLXByb2plY3QgY2E3OTMzZTQ3ZDNhMzQ1MWQ4MWU3MmFjMTc0ZGNiNWFhMjhiNTlkMSkAlAEPdGFyZ2V0X2ZlYXR1cmVzCCsLYnVsay1tZW1vcnkrD2J1bGstbWVtb3J5LW9wdCsWY2FsbC1pbmRpcmVjdC1vdmVybG9uZysKbXVsdGl2YWx1ZSsPbXV0YWJsZS1nbG9iYWxzKxNub250cmFwcGluZy1mcHRvaW50Kw9yZWZlcmVuY2UtdHlwZXMrCHNpZ24tZXh0";

/** Portable base64 → bytes (no atob/Buffer dependency; runs in Node + browser). */
function b64ToBytes(s: string): Uint8Array {
  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lut = new Int16Array(256).fill(-1);
  for (let i = 0; i < table.length; i++) lut[table.charCodeAt(i)] = i;
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((clean.length * 3) >> 2);
  let bits = 0;
  let nbits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lut[clean.charCodeAt(i)];
    if (v < 0) continue;
    bits = (bits << 6) | v;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      out[o++] = (bits >> nbits) & 0xff;
    }
  }
  return out;
}

/**
 * Seed version. Bump this when the bundled default content changes so existing
 * users (whose SD is persisted in IndexedDB) get the updated demos re-seeded.
 */
export const SEED_VERSION = 3;

/** Seed an SD card with the bundled demo games and default system files. */
export async function seedMockContent(sd: MemorySDCard): Promise<void> {
  sd.mkdirSync("/games/demo", true);
  sd.writeFileSync("/games/demo/main.lua", DEMO_LUA);
  sd.writeFileSync(
    "/games/demo/meta.lua",
    'return { title = "Bounce Demo" }\n',
  );
  sd.mkdirSync("/games/snake", true);
  sd.writeFileSync("/games/snake/main.lua", SNAKE_LUA);
  sd.writeFileSync("/games/snake/meta.lua", 'return { title = "Snake" }\n');
  // A C-accelerated demo: a Lua game + its compiled native helper on the SD.
  sd.mkdirSync("/games/ripple", true);
  sd.writeFileSync("/games/ripple/main.lua", RIPPLE_LUA);
  sd.writeFileSync("/games/ripple/meta.lua", 'return { title = "Ripple (C)" }\n');
  sd.writeFileSync("/games/ripple/game.json", RIPPLE_GAME_JSON);
  sd.writeFileSync("/games/ripple/ripple.fwmod", b64ToBytes(RIPPLE_FWMOD_B64));
  sd.mkdirSync("/system", true);
  sd.writeFileSync(
    "/system/settings.json",
    '{ "wifi": [], "lastLevel": 0.75 }\n',
  );
}

const EMPTY = new Uint8Array(0);

function now(): number {
  return Date.now();
}

function normalize(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function dirname(path: string): string {
  const p = normalize(path);
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function basename(path: string): string {
  const p = normalize(path);
  if (p === "/") return "/";
  return p.slice(p.lastIndexOf("/") + 1);
}

function toStat(path: string, node: Node): FileStat {
  return {
    path,
    name: basename(path),
    type: node.type,
    size: node.data.length,
    mtime: node.mtime,
  };
}
