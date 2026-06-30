import { describe, expect, it } from "vitest";
import { Arch, FwModule } from "./format.js";
import { loadFwmod } from "./loader.js";

describe("loadFwmod", () => {
  it("loads a valid module but marks it not-runnable until Phase 5", () => {
    const bytes = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4]),
      arch: Arch.XtensaLx7,
    }).encode();
    const r = loadFwmod(bytes);
    expect(r.loadable).toBe(true);
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/no execution backend/);
    expect(r.info?.archLabel).toBe("xtensa-lx7");
    expect(r.problems).toEqual([]);
  });

  it("does not throw on undecodable bytes", () => {
    const r = loadFwmod(new Uint8Array([1, 2, 3]));
    expect(r.info).toBeNull();
    expect(r.loadable).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("rejects a module built against a newer ABI than the host", () => {
    const bytes = new FwModule({
      payload: new Uint8Array([1]),
      arch: Arch.XtensaLx7,
      abiVersion: 99,
    }).encode();
    const r = loadFwmod(bytes); // host ABI defaults to 1
    expect(r.loadable).toBe(false);
    expect(r.problems.some((p) => p.includes("ABI"))).toBe(true);
  });
});
