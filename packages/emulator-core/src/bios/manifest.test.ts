import { describe, expect, it } from "vitest";
import { MemorySDCard } from "../device/memory-sd.js";
import { Arch, FwModule, loadFwmod } from "../fwmod/index.js";
import { resolveGame } from "./manifest.js";

function dir(sd: MemorySDCard, path: string): void {
  sd.mkdirSync(path, true);
}

describe("resolveGame", () => {
  it("falls back to main.lua + meta.lua title without a manifest", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/snake");
    sd.writeFileSync("/games/snake/main.lua", "");
    sd.writeFileSync("/games/snake/meta.lua", 'return { title = "Snake" }');
    const r = resolveGame(sd, "/games/snake", "snake");
    expect(r.source).toBe("scan");
    expect(r.title).toBe("Snake");
    expect(r.entryPath).toBe("/games/snake/main.lua");
    expect(r.modules).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("reads entry, title, and modules from game.json", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/x");
    sd.writeFileSync("/games/x/start.lua", "");
    sd.writeFileSync(
      "/games/x/game.json",
      JSON.stringify({
        title: "Cool Game",
        entry: "start.lua",
        modules: [{ name: "phys", path: "phys.fwmod" }],
      }),
    );
    const r = resolveGame(sd, "/games/x", "x");
    expect(r.source).toBe("game.json");
    expect(r.title).toBe("Cool Game");
    expect(r.entryPath).toBe("/games/x/start.lua");
    expect(r.modules).toEqual([{ name: "phys", path: "/games/x/phys.fwmod" }]);
    expect(r.warnings).toEqual([]);
  });

  it("rejects path traversal in entry and module paths", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/x");
    sd.writeFileSync(
      "/games/x/game.json",
      JSON.stringify({
        entry: "../escape.lua",
        modules: [{ path: "/etc/passwd" }, { path: "../../x.fwmod" }],
      }),
    );
    const r = resolveGame(sd, "/games/x", "x");
    expect(r.entryPath).toBe("/games/x/main.lua"); // fell back to safe default
    expect(r.modules).toEqual([]);
    expect(r.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("degrades to main.lua on malformed JSON", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/x");
    sd.writeFileSync("/games/x/game.json", "{ not valid json");
    const r = resolveGame(sd, "/games/x", "x");
    expect(r.source).toBe("scan");
    expect(r.entryPath).toBe("/games/x/main.lua");
    expect(r.warnings.length).toBe(1);
  });

  it("deduplicates modules that resolve to the same path", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/x");
    sd.writeFileSync("/games/x/main.lua", "");
    sd.writeFileSync(
      "/games/x/game.json",
      JSON.stringify({
        modules: [
          { name: "a", path: "phys.fwmod" },
          { name: "b", path: "phys.fwmod" },
        ],
      }),
    );
    const r = resolveGame(sd, "/games/x", "x");
    expect(r.modules).toEqual([{ name: "a", path: "/games/x/phys.fwmod" }]);
    expect(r.warnings.some((w) => w.includes("duplicate"))).toBe(true);
  });

  it("produces module paths that load through the fwmod loader", () => {
    const sd = new MemorySDCard();
    dir(sd, "/games/x");
    sd.writeFileSync("/games/x/main.lua", "");
    sd.writeFileSync(
      "/games/x/game.json",
      JSON.stringify({ modules: [{ name: "m", path: "m.fwmod" }] }),
    );
    const bytes = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4]),
      arch: Arch.XtensaLx7,
    }).encode();
    sd.writeFileSync("/games/x/m.fwmod", bytes);

    const r = resolveGame(sd, "/games/x", "x");
    expect(r.modules).toHaveLength(1);
    const loaded = loadFwmod(sd.readFileSync(r.modules[0].path));
    expect(loaded.loadable).toBe(true);
    expect(loaded.info?.archLabel).toBe("xtensa-lx7");
  });
});
