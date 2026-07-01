import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { isAccelerator, type AcceleratorRuntime } from "./module-runtime.js";
import { WasmModuleRuntime } from "./wasm-runtime.js";
import { XtensaModuleRuntime } from "./xtensa/xtensa-runtime.js";

/**
 * Layer 1 of the Lua↔native bridge, proven WITHOUT Lua: the accelerator surface
 * (named exports + host-allocated buffers in the module's own memory) works
 * identically on both native backends. One examples/fxmod.c compiled by clang
 * (wasm32) and gcc (Xtensa call0) — the host allocs a buffer, the module's
 * `shade` export fills it in tight C, and `sum` reduces it — must produce
 * byte-identical buffers and equal sums across backends. That's the same
 * differential oracle as the game path, now over the export/buffer ABI.
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): Uint8Array =>
  new Uint8Array(
    readFileSync(path.resolve(dirname, "../../../../tools/fwmod/fixtures", n)),
  );

type Backend = new (
  device: EmulatedFlywheelDevice,
) => AcceleratorRuntime & { load(b: Uint8Array): Promise<boolean> };

async function load(Runtime: Backend, name: string): Promise<AcceleratorRuntime> {
  const rt = new Runtime(new EmulatedFlywheelDevice());
  const ok = await rt.load(fixture(name));
  if (!ok) throw new Error(`load failed: ${name}`);
  return rt;
}

const WASM = "fxmod-clang-wasm32.fwmod";
const XT = "fxmod-gcc-xtensa.fwmod";
const W = 40;
const H = 8;
const T = 5;

function shadeAndSum(rt: AcceleratorRuntime) {
  const ptr = rt.alloc(W * H);
  const wrote = rt.callExport("shade", [ptr, W, H, T]);
  const buf = rt.read(ptr, W * H);
  const sum = rt.callExport("sum", [ptr, W * H]);
  return { ptr, wrote, buf, sum };
}

describe("accelerator differential: clang-wasm32 vs gcc-xtensa (fxmod.c)", () => {
  it("both backends expose the same named exports", async () => {
    const w = await load(WasmModuleRuntime, WASM);
    const x = await load(XtensaModuleRuntime, XT);
    expect(isAccelerator(w) && isAccelerator(x)).toBe(true);
    expect(new Set(w.exports)).toEqual(new Set(["shade", "sum"]));
    expect(new Set(x.exports)).toEqual(new Set(["shade", "sum"]));
    w.dispose();
    x.dispose();
  });

  it("shade fills a buffer byte-identically across backends; sum agrees", async () => {
    const w = await load(WasmModuleRuntime, WASM);
    const x = await load(XtensaModuleRuntime, XT);
    const rw = shadeAndSum(w);
    const rx = shadeAndSum(x);

    expect(rw.wrote).toBe(W * H);
    expect(rx.wrote).toBe(W * H);
    // The pattern the C wrote: buf[y*W + x] = (x + y + T) & 0xff.
    expect(rw.buf[0]).toBe((0 + 0 + T) & 0xff);
    expect(rw.buf[W * H - 1]).toBe((W - 1 + (H - 1) + T) & 0xff);
    // Byte-for-byte identical buffers — the differential oracle over buffers.
    expect([...rx.buf]).toEqual([...rw.buf]);
    // sum() reduced the same bytes on both, and matches a JS recomputation.
    const expected = [...rw.buf].reduce((a, b) => a + b, 0);
    expect(rw.sum).toBe(expected);
    expect(rx.sum).toBe(expected);

    w.dispose();
    x.dispose();
  });

  it("host writes into the buffer are visible to the module", async () => {
    for (const [Runtime, name] of [
      [WasmModuleRuntime, WASM],
      [XtensaModuleRuntime, XT],
    ] as const) {
      const rt = await load(Runtime, name);
      const ptr = rt.alloc(16);
      rt.write(ptr, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
      expect(rt.callExport("sum", [ptr, 16])).toBe(136); // 1..16
      rt.dispose();
    }
  });

  it("separate allocations don't overlap", async () => {
    const x = await load(XtensaModuleRuntime, XT);
    const a = x.alloc(32);
    const b = x.alloc(32);
    expect(b).toBeGreaterThanOrEqual(a + 32);
    x.dispose();
  });

  it("a plain game module exposes no exports", async () => {
    const x = await load(XtensaModuleRuntime, "hello-gcc-xtensa.fwmod");
    expect(x.exports).toEqual([]);
    x.dispose();
  });
});
