import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Arch, archName, decodeFwmod } from "./format.js";
import { loadFwmod } from "./loader.js";

// The golden fixture is written by the Python CLI (tools/fwmod) and decoded
// here, so the two codecs cannot drift. Regenerate with:
//   cd tools/fwmod && python fixtures/make_golden.py
const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(dirname, "../../../../tools/fwmod/fixtures");

interface Golden {
  format_version: number;
  abi_version: number;
  arch: number;
  arch_name: string;
  flags: number;
  code_size: number;
  bss_size: number;
  entry_offset: number;
  load_addr: number;
  crc32: number;
  payload_hex: string;
}

describe("fwmod cross-language conformance", () => {
  it("decodes the Python-written golden fixture to the expected fields", () => {
    const golden = JSON.parse(
      readFileSync(path.join(fixtures, "golden.json"), "utf8"),
    ) as Golden;
    const bytes = new Uint8Array(readFileSync(path.join(fixtures, "golden.fwmod")));
    const m = decodeFwmod(bytes);

    expect(m.formatVersion).toBe(golden.format_version);
    expect(m.abiVersion).toBe(golden.abi_version);
    expect(m.arch).toBe(golden.arch);
    expect(m.archLabel).toBe(golden.arch_name);
    expect(m.flags).toBe(golden.flags);
    expect(m.codeSize).toBe(golden.code_size);
    expect(m.bssSize).toBe(golden.bss_size);
    expect(m.entryOffset).toBe(golden.entry_offset);
    expect(m.loadAddr).toBe(golden.load_addr);
    expect(m.computedCrc32).toBe(golden.crc32);
    expect(m.storedCrc32).toBe(golden.crc32);
    expect(Buffer.from(m.payload).toString("hex")).toBe(golden.payload_hex);
    expect(m.validate()).toEqual([]);
  });

  it("reads a real compiler-produced module (hello.c built by the CLI)", () => {
    // A frozen .fwmod compiled from examples/hello.c by the Python CLI + MinGW.
    // Proves the TS reader accepts genuine toolchain output, not just synthetic
    // payloads. Not regenerated in CI (depends on a C toolchain); regenerate
    // with: cd tools/fwmod && python -m fwmod build examples/hello.c \
    //   -o fixtures/hello-host-x86.fwmod --arch host-x86 --toolchain-dir <bin>
    const bytes = new Uint8Array(
      readFileSync(path.join(fixtures, "hello-host-x86.fwmod")),
    );
    const m = decodeFwmod(bytes);
    expect(m.validate()).toEqual([]);
    expect(m.arch).toBe(Arch.HostX86);
    expect(m.entryOffset).toBe(0);
    expect(m.codeSize).toBeGreaterThan(0);

    const loaded = loadFwmod(bytes);
    expect(loaded.loadable).toBe(true);
    expect(loaded.runnable).toBe(false); // no host-x86 backend in Phase 4
  });

  it("agrees with Python's arch int->name table (guards the duplicated tables)", () => {
    // arch_table.json is emitted by tools/fwmod from Python's table; assert the
    // independently-maintained TS table matches it value-for-value.
    const table = JSON.parse(
      readFileSync(path.join(fixtures, "arch_table.json"), "utf8"),
    ) as Record<string, string>;
    const entries = Object.entries(table);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const [value, name] of entries) {
      expect(archName(Number(value))).toBe(name);
    }
    // Every named Arch enum value is covered by the table.
    for (const value of Object.values(Arch)) {
      expect(table[String(value)]).toBe(archName(value));
    }
  });
});
