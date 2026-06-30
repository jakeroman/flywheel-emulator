import { describe, expect, it } from "vitest";
import { readBytes, readCString, writeBytes } from "./wasm-memory.js";

function mem(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 }); // 64 KiB
}

function put(memory: WebAssembly.Memory, ptr: number, bytes: number[]): void {
  new Uint8Array(memory.buffer).set(bytes, ptr);
}

describe("wasm-memory", () => {
  it("reads a NUL-terminated string", () => {
    const m = mem();
    put(m, 100, [0x48, 0x49, 0x00]); // "HI\0"
    expect(readCString(m, 100)).toBe("HI");
  });

  it("returns '' for null/out-of-bounds pointers", () => {
    const m = mem();
    expect(readCString(m, 0)).toBe("");
    expect(readCString(m, -4)).toBe("");
    expect(readCString(m, 10_000_000)).toBe("");
  });

  it("stops an unterminated string at maxLen without reading past the buffer", () => {
    const m = mem();
    const bytes = new Uint8Array(m.buffer);
    bytes.fill(0x41, 100, 200); // 'A' x100, no NUL
    expect(readCString(m, 100, 8)).toBe("AAAAAAAA");
  });

  it("writeBytes clamps to cap and to the buffer, returning the count written", () => {
    const m = mem();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(writeBytes(m, 50, data, 3)).toBe(3); // capped at 3
    expect(Array.from(readBytes(m, 50, 5))).toEqual([1, 2, 3, 0, 0]);
    expect(writeBytes(m, -1, data, 5)).toBe(0); // bad ptr
  });

  it("readBytes copies (survives a later overwrite)", () => {
    const m = mem();
    put(m, 10, [9, 8, 7]);
    const copy = readBytes(m, 10, 3);
    new Uint8Array(m.buffer).set([0, 0, 0], 10);
    expect(Array.from(copy)).toEqual([9, 8, 7]);
  });
});
