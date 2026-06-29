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
 * authoritative store; Phase 1 layers IndexedDB persistence and import/export
 * on top without changing this behavior.
 */
export class MemorySDCard implements SDCard {
  readonly events = new Emitter<SDEvents>();
  private readonly nodes = new Map<string, Node>();

  constructor() {
    this.nodes.set("/", { type: "dir", data: EMPTY, mtime: now() });
  }

  async exists(path: string): Promise<boolean> {
    return this.nodes.has(normalize(path));
  }

  async stat(path: string): Promise<FileStat | null> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    return node ? toStat(p, node) : null;
  }

  async readDir(path: string): Promise<readonly FileStat[]> {
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

  async mkdir(path: string, recursive = false): Promise<void> {
    const p = normalize(path);
    if (this.nodes.has(p)) {
      if (this.nodes.get(p)!.type === "dir") return;
      throw new Error(`EEXIST: ${p}`);
    }
    const parent = dirname(p);
    const parentNode = this.nodes.get(parent);
    if (!parentNode) {
      if (!recursive) throw new Error(`ENOENT: ${parent}`);
      await this.mkdir(parent, true);
    } else if (parentNode.type !== "dir") {
      throw new Error(`ENOTDIR: ${parent}`);
    }
    this.nodes.set(p, { type: "dir", data: EMPTY, mtime: now() });
    this.events.emit("change", { path: p });
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = normalize(path);
    const node = this.nodes.get(p);
    if (!node) throw new Error(`ENOENT: ${p}`);
    if (node.type !== "file") throw new Error(`EISDIR: ${p}`);
    return node.data;
  }

  async readTextFile(path: string): Promise<string> {
    return decoder.decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
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

  async remove(path: string): Promise<void> {
    const p = normalize(path);
    if (p === "/") throw new Error("EPERM: cannot remove root");
    if (!this.nodes.has(p)) throw new Error(`ENOENT: ${p}`);
    const prefix = p + "/";
    for (const key of [...this.nodes.keys()]) {
      if (key === p || key.startsWith(prefix)) this.nodes.delete(key);
    }
    this.events.emit("change", { path: p });
  }

  async rename(from: string, to: string): Promise<void> {
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
}

/** Seed an SD card with a little mock content for the Phase 0 file browser. */
export async function seedMockContent(sd: MemorySDCard): Promise<void> {
  await sd.mkdir("/games", true);
  await sd.mkdir("/games/snake", true);
  await sd.writeFile(
    "/games/snake/main.lua",
    "-- Snake (placeholder)\nfunction _init() end\nfunction _update() end\nfunction _draw() end\n",
  );
  await sd.writeFile(
    "/games/snake/meta.lua",
    'return { title = "Snake", icon = "icon.fwb" }\n',
  );
  await sd.mkdir("/games/starfield", true);
  await sd.writeFile(
    "/games/starfield/main.lua",
    "-- Starfield (placeholder)\nfunction _draw() end\n",
  );
  await sd.writeFile(
    "/games/starfield/meta.lua",
    'return { title = "Starfield" }\n',
  );
  await sd.mkdir("/system", true);
  await sd.writeFile(
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
