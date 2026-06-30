/**
 * Regenerate the wasm32 conformance fixture.
 *
 * Run from anywhere:  node tools/fwmod/fixtures/make_wasm_fixture.mjs
 *
 * Assembles examples/hello-wasm.wat to wasm (via the wabt npm package, a
 * dev-only dependency) and packs it into hello-wasm32.fwmod with the canonical
 * `python -m fwmod pack` (arch=wasm32). The committed .fwmod is what the runtime
 * tests instantiate; CI needs neither wabt nor Python (it reads the fixture),
 * exactly like make_golden.py / hello-host-x86.fwmod.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import wabtInit from "wabt";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolDir = path.join(here, ".."); // tools/fwmod
const watPath = path.join(toolDir, "examples", "hello-wasm.wat");
const wasmTmp = path.join(here, "hello-wasm.wasm");
const out = path.join(here, "hello-wasm32.fwmod");

const wabt = await wabtInit();
const parsed = wabt.parseWat(path.basename(watPath), readFileSync(watPath, "utf8"));
const { buffer } = parsed.toBinary({});
parsed.destroy();
writeFileSync(wasmTmp, Buffer.from(buffer));

try {
  execFileSync(
    "python",
    ["-m", "fwmod", "pack", wasmTmp, "-o", out, "--arch", "wasm32"],
    { cwd: toolDir, stdio: "inherit" },
  );
} finally {
  rmSync(wasmTmp, { force: true });
}
console.log(`wrote ${path.relative(process.cwd(), out)} (payload ${buffer.byteLength} bytes)`);
