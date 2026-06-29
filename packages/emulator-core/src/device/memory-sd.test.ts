import { describe, expect, it } from "vitest";
import { MemorySDCard } from "./memory-sd.js";

async function setup(): Promise<MemorySDCard> {
  const sd = new MemorySDCard();
  await sd.mkdir("/games/snake", true);
  await sd.writeFile("/games/snake/main.lua", "-- snake\n");
  return sd;
}

describe("MemorySDCard", () => {
  it("creates directories recursively and lists direct children", async () => {
    const sd = await setup();
    const root = await sd.readDir("/");
    expect(root.map((e) => e.name)).toEqual(["games"]);
    const games = await sd.readDir("/games");
    expect(games.map((e) => e.name)).toEqual(["snake"]);
  });

  it("reads back written file content", async () => {
    const sd = await setup();
    expect(await sd.readTextFile("/games/snake/main.lua")).toBe("-- snake\n");
  });

  it("normalizes paths (.., //, .)", async () => {
    const sd = await setup();
    expect(await sd.readTextFile("/games/../games/snake/./main.lua")).toBe(
      "-- snake\n",
    );
  });

  it("rejects writing under a file parent (ENOTDIR)", async () => {
    const sd = await setup();
    await expect(
      sd.writeFile("/games/snake/main.lua/child", "x"),
    ).rejects.toThrow(/ENOTDIR/);
  });

  it("rejects mkdir under a file parent (ENOTDIR)", async () => {
    const sd = await setup();
    await expect(sd.mkdir("/games/snake/main.lua/sub")).rejects.toThrow(
      /ENOTDIR/,
    );
  });

  it("renames a subtree to a new location", async () => {
    const sd = await setup();
    await sd.mkdir("/apps");
    await sd.rename("/games/snake", "/apps/snake");
    expect(await sd.exists("/games/snake")).toBe(false);
    expect(await sd.readTextFile("/apps/snake/main.lua")).toBe("-- snake\n");
  });

  it("refuses to move a directory into its own subtree (EINVAL)", async () => {
    const sd = await setup();
    await expect(sd.rename("/games", "/games/sub")).rejects.toThrow(/EINVAL/);
    // The original tree is untouched.
    expect(await sd.exists("/games/snake/main.lua")).toBe(true);
  });

  it("refuses to rename onto an existing path (EEXIST)", async () => {
    const sd = await setup();
    await sd.mkdir("/apps");
    await expect(sd.rename("/games", "/apps")).rejects.toThrow(/EEXIST/);
  });

  it("refuses to rename into a non-existent parent (ENOENT)", async () => {
    const sd = await setup();
    await expect(sd.rename("/games", "/nope/games")).rejects.toThrow(/ENOENT/);
  });

  it("removes a directory subtree", async () => {
    const sd = await setup();
    await sd.remove("/games");
    expect(await sd.exists("/games")).toBe(false);
    expect(await sd.exists("/games/snake/main.lua")).toBe(false);
  });

  it("emits a change event on mutation", async () => {
    const sd = new MemorySDCard();
    let changes = 0;
    sd.events.on("change", () => changes++);
    await sd.mkdir("/x");
    await sd.writeFile("/x/a.txt", "hi");
    expect(changes).toBeGreaterThanOrEqual(2);
  });
});
