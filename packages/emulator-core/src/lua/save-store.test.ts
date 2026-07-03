import { describe, expect, it } from "vitest";
import { MemorySDCard } from "../device/memory-sd.js";
import { createSaveApi } from "./save-store.js";

const DIR = "/saves/testgame";
const FILE = `${DIR}/save.json`;

describe("createSaveApi", () => {
  it("returns undefined (Lua nil) for an unset key, or the given default", () => {
    const sd = new MemorySDCard();
    const save = createSaveApi(sd, DIR);
    // undefined (not JS null) so wasmoon marshals it to Lua nil, not a truthy
    // `null` userdata — see the "== nil" integration test in lua-runtime.test.
    expect(save.get("missing")).toBeUndefined();
    expect(save.get("missing", 42)).toBe(42);
    expect(save.has("missing")).toBe(false);
    expect(save.keys()).toEqual([]);
  });

  it("persists values to save.json and reads them back in a fresh instance", () => {
    const sd = new MemorySDCard();
    const a = createSaveApi(sd, DIR);
    a.set("best", 1200);
    a.set("name", "ADA");
    a.set("unlocked", true);

    // A brand-new instance reads only from the SD — proves it was persisted.
    const b = createSaveApi(sd, DIR);
    expect(b.get("best")).toBe(1200);
    expect(b.get("name")).toBe("ADA");
    expect(b.get("unlocked")).toBe(true);
    expect(b.has("best")).toBe(true);
    expect(b.keys().sort()).toEqual(["best", "name", "unlocked"]);
  });

  it("creates the save directory on first write", () => {
    const sd = new MemorySDCard();
    expect(sd.existsSync(DIR)).toBe(false);
    createSaveApi(sd, DIR).set("k", 1);
    expect(sd.existsSync(DIR)).toBe(true);
    expect(sd.existsSync(FILE)).toBe(true);
  });

  it("round-trips nested tables (arrays and maps)", () => {
    const sd = new MemorySDCard();
    const a = createSaveApi(sd, DIR);
    a.set("scores", [10, 20, 30]);
    a.set("profile", { level: 3, flags: { hard: true } });

    const b = createSaveApi(sd, DIR);
    expect(b.get("scores")).toEqual([10, 20, 30]);
    expect(b.get("profile")).toEqual({ level: 3, flags: { hard: true } });
  });

  it("does not let a returned object mutate the cache", () => {
    const sd = new MemorySDCard();
    const save = createSaveApi(sd, DIR);
    save.set("obj", { n: 1 });
    const got = save.get("obj") as { n: number };
    got.n = 999; // mutate the copy the game holds
    expect((save.get("obj") as { n: number }).n).toBe(1);
  });

  it("clears a key when set to nil / null / a non-finite number", () => {
    const sd = new MemorySDCard();
    const save = createSaveApi(sd, DIR);
    save.set("hp", 100);
    save.set("hp", null); // Lua nil arrives as null/undefined → clear
    expect(save.has("hp")).toBe(false);
    expect(save.get("hp", -1)).toBe(-1);

    save.set("score", 7);
    save.set("score", Infinity); // no storable representation → clear
    expect(save.has("score")).toBe(false);

    save.set("nan", NaN);
    save.set("missing", undefined); // clearing an absent key: no-op
    expect(save.has("nan")).toBe(false);
    expect(save.keys()).toEqual([]);
  });

  it("preserves nulls nested inside a stored table", () => {
    const sd = new MemorySDCard();
    const save = createSaveApi(sd, DIR);
    save.set("slots", [1, null, 3]);
    expect(save.get("slots")).toEqual([1, null, 3]);
  });

  it("rolls the cache back to disk when a write fails (stays consistent)", () => {
    // A fake SD whose writeFileSync throws once we arm it.
    let fail = false;
    const store = new MemorySDCard();
    const sd = {
      existsSync: (p: string) => store.existsSync(p),
      readTextFileSync: (p: string) => store.readTextFileSync(p),
      mkdirSync: (p: string, r?: boolean) => store.mkdirSync(p, r),
      removeSync: (p: string) => store.removeSync(p),
      writeFileSync: (p: string, d: string) => {
        if (fail) throw new Error("ENOSPC: disk full");
        store.writeFileSync(p, d);
      },
    };
    const save = createSaveApi(sd, DIR);
    save.set("best", 100);
    fail = true;
    expect(() => save.set("best", 999)).toThrow(/ENOSPC/);
    // Cache did not diverge: it still reports the last successfully-persisted value.
    expect(save.get("best")).toBe(100);
    // And a fresh instance reads the same from disk.
    fail = false;
    expect(createSaveApi(sd, DIR).get("best")).toBe(100);
  });

  it("rejects unserializable values (functions)", () => {
    const sd = new MemorySDCard();
    const save = createSaveApi(sd, DIR);
    expect(() => save.set("fn", () => 1)).toThrow(/cannot save a function/);
  });

  it("deletes a key and persists the removal", () => {
    const sd = new MemorySDCard();
    createSaveApi(sd, DIR).set("keep", 1);
    const a = createSaveApi(sd, DIR);
    a.set("drop", 2);
    a.delete("drop");
    expect(a.has("drop")).toBe(false);

    const b = createSaveApi(sd, DIR);
    expect(b.has("drop")).toBe(false);
    expect(b.get("keep")).toBe(1);
  });

  it("clear() erases the whole save file", () => {
    const sd = new MemorySDCard();
    const a = createSaveApi(sd, DIR);
    a.set("x", 1);
    a.set("y", 2);
    a.clear();
    expect(a.keys()).toEqual([]);
    expect(sd.existsSync(FILE)).toBe(false);

    const b = createSaveApi(sd, DIR);
    expect(b.keys()).toEqual([]);
  });

  it("survives a corrupt save.json by starting empty", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync(DIR, true);
    sd.writeFileSync(FILE, "{ this is not valid json");
    const save = createSaveApi(sd, DIR);
    expect(save.keys()).toEqual([]);
    expect(save.get("anything", "dflt")).toBe("dflt");
    // And it can recover by writing fresh data.
    save.set("ok", 1);
    expect(createSaveApi(sd, DIR).get("ok")).toBe(1);
  });

  it("ignores a save.json that is not a JSON object", () => {
    const sd = new MemorySDCard();
    sd.mkdirSync(DIR, true);
    sd.writeFileSync(FILE, "[1,2,3]"); // valid JSON, wrong shape
    const save = createSaveApi(sd, DIR);
    expect(save.keys()).toEqual([]);
  });

  it("treats dangerous keys like __proto__ as ordinary data", () => {
    const sd = new MemorySDCard();
    const a = createSaveApi(sd, DIR);
    a.set("__proto__", { hacked: true });
    a.set("constructor", 7);
    expect(a.get("__proto__")).toEqual({ hacked: true });
    expect(a.get("constructor")).toBe(7);
    // No global/prototype pollution.
    expect(({} as Record<string, unknown>).hacked).toBeUndefined();

    const b = createSaveApi(sd, DIR);
    expect(b.get("__proto__")).toEqual({ hacked: true });
    expect(b.keys().sort()).toEqual(["__proto__", "constructor"]);
  });

  it("keeps two games' saves separate", () => {
    const sd = new MemorySDCard();
    const one = createSaveApi(sd, "/saves/one");
    const two = createSaveApi(sd, "/saves/two");
    one.set("score", 100);
    two.set("score", 7);
    expect(one.get("score")).toBe(100);
    expect(two.get("score")).toBe(7);
    expect(one.dir).toBe("/saves/one");
  });
});
