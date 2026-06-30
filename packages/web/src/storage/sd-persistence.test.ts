import { describe, expect, it } from "vitest";
import { MemorySDCard } from "@flywheel/emulator-core";
import { exportToBlob, importFromText } from "./sd-persistence.js";

describe("SD archive export/import", () => {
  it("round-trips files (incl. binary) and directories, replacing the target", async () => {
    const src = new MemorySDCard();
    src.mkdirSync("/games/demo", true);
    src.writeFileSync("/games/demo/main.lua", "print('hi')");
    src.writeFileSync("/bin", new Uint8Array([0, 1, 2, 255, 128]));

    const text = await exportToBlob(src).text();

    const dst = new MemorySDCard();
    dst.writeFileSync("/stale.txt", "old"); // should be wiped by import
    importFromText(dst, text);

    expect(dst.existsSync("/stale.txt")).toBe(false);
    expect(dst.readTextFileSync("/games/demo/main.lua")).toBe("print('hi')");
    expect(Array.from(dst.readFileSync("/bin"))).toEqual([0, 1, 2, 255, 128]);
    expect(dst.statSync("/games/demo")?.type).toBe("dir");
  });

  it("rejects an unrecognized archive", () => {
    const sd = new MemorySDCard();
    expect(() => importFromText(sd, '{"nope":true}')).toThrow();
  });
});
