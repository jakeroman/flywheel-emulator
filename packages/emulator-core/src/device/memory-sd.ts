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

/** Seed an SD card with a little mock content for the file browser / demos. */
export async function seedMockContent(sd: MemorySDCard): Promise<void> {
  sd.mkdirSync("/games", true);
  sd.mkdirSync("/games/demo", true);
  sd.writeFileSync("/games/demo/main.lua", DEMO_LUA);
  sd.writeFileSync(
    "/games/demo/meta.lua",
    'return { title = "Bounce Demo" }\n',
  );
  sd.mkdirSync("/games/snake", true);
  sd.writeFileSync(
    "/games/snake/main.lua",
    "-- Snake (placeholder)\nfunction _init() end\nfunction _update() end\nfunction _draw() end\n",
  );
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
