/**
 * SD card / virtual filesystem abstraction.
 *
 * Content (games, BIOS data, Lua apps) lives on an SD card. In the emulator
 * this is a virtual filesystem held in memory and (Phase 1) persisted to
 * IndexedDB with import/export. The interface is async because the persistent
 * backend is async; in-memory implementations simply resolve immediately.
 *
 * SYNC-READ PLAN (Phase 1): wasmoon Lua and the BIOS run synchronously inside
 * the per-frame run loop and cannot await a file read mid-frame. The resident
 * filesystem is always RAM-backed (true of a mounted SD card too), so the plan
 * is to add a synchronous read view — e.g. `SDCacheView` with
 * `readFileSync`/`statSync`/`readDirSync` over the resident store — while this
 * async interface stays the persistence/transfer boundary (IndexedDB flush,
 * import/export). Phase 1 code must read through the sync view, NOT await
 * everywhere, or the BIOS file access will need rewriting later.
 *
 * Paths are POSIX-style, absolute, "/"-separated (e.g. "/games/snake/main.lua").
 */

import type { Emitter } from "../util/emitter.js";

export interface FileStat {
  readonly path: string;
  readonly name: string;
  readonly type: "file" | "dir";
  readonly size: number;
  /** Last-modified time in ms since epoch (0 if unknown). */
  readonly mtime: number;
}

export interface SDEvents {
  /** Fired after any mutation, with the path that changed. */
  change: { path: string };
}

/**
 * Synchronous access to the resident (RAM-backed) filesystem. The BIOS and Lua
 * call these inside the per-frame run loop, where awaiting is impossible. The
 * async SDCard methods are the persistence/transfer boundary; both views
 * operate on the same resident store.
 */
export interface SyncSDAccess {
  existsSync(path: string): boolean;
  statSync(path: string): FileStat | null;
  readDirSync(path: string): readonly FileStat[];
  mkdirSync(path: string, recursive?: boolean): void;
  readFileSync(path: string): Uint8Array;
  readTextFileSync(path: string): string;
  writeFileSync(path: string, data: Uint8Array | string): void;
  removeSync(path: string): void;
  renameSync(from: string, to: string): void;
}

export interface SDCard extends SyncSDAccess {
  /** Live change notifications for observers (file browser, dev tools). */
  readonly events: Emitter<SDEvents>;

  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | null>;

  /** List the entries directly inside a directory. */
  readDir(path: string): Promise<readonly FileStat[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;

  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;

  /** Remove a file or directory (recursive for directories). */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}
