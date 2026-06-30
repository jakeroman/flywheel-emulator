import { describe, expect, it } from "vitest";
import { crc32 } from "./crc32.js";
import { Arch, decodeFwmod, FwModule, HEADER_SIZE } from "./format.js";

describe("crc32", () => {
  it("matches the standard check vector", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("FwModule codec", () => {
  it("round-trips encode/decode", () => {
    const m = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4]),
      arch: Arch.HostX86,
      entryOffset: 1,
      bssSize: 8,
      loadAddr: 0x1000,
    });
    const d = decodeFwmod(m.encode());
    expect(Array.from(d.payload)).toEqual([1, 2, 3, 4]);
    expect(d.arch).toBe(Arch.HostX86);
    expect(d.entryOffset).toBe(1);
    expect(d.bssSize).toBe(8);
    expect(d.loadAddr).toBe(0x1000);
    expect(d.storedCrc32).toBe(m.computedCrc32);
    expect(d.validate()).toEqual([]);
  });

  it("reports a crc mismatch on a corrupted payload", () => {
    const blob = new FwModule({
      payload: new Uint8Array([10, 20, 30]),
      arch: Arch.HostX86,
    }).encode();
    blob[HEADER_SIZE] ^= 0xff; // corrupt the first payload byte
    const problems = decodeFwmod(blob).validate();
    expect(problems.some((p) => p.includes("crc32 mismatch"))).toBe(true);
  });

  it("flags entry_offset outside the payload", () => {
    const m = new FwModule({ payload: new Uint8Array([1]), entryOffset: 5 });
    expect(m.validate().some((p) => p.includes("entry_offset"))).toBe(true);
  });

  it("flags an empty payload and a nonzero reserved field", () => {
    expect(
      new FwModule({ payload: new Uint8Array(0) })
        .validate()
        .some((p) => p.includes("empty payload")),
    ).toBe(true);
    expect(
      new FwModule({ payload: new Uint8Array([1]), reserved: 7 })
        .validate()
        .some((p) => p.includes("reserved")),
    ).toBe(true);
  });

  it("throws on bad magic and on too-small buffers", () => {
    expect(() => decodeFwmod(new Uint8Array(10))).toThrow(/too small/);
    const bad = new FwModule({ payload: new Uint8Array([1]) }).encode();
    bad[0] = 0x00;
    expect(() => decodeFwmod(bad)).toThrow(/bad magic/);
  });

  it("throws on a truncated payload", () => {
    const blob = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    }).encode();
    expect(() => decodeFwmod(blob.subarray(0, blob.length - 2))).toThrow(
      /truncated/,
    );
  });

  it("encode throws (not silently truncates) on out-of-range fields", () => {
    expect(() =>
      new FwModule({ payload: new Uint8Array([1]), abiVersion: 70000 }).encode(),
    ).toThrow(/abi_version out of range/);
    expect(() =>
      new FwModule({ payload: new Uint8Array([1]), loadAddr: 0x100000000 }).encode(),
    ).toThrow(/load_addr out of range/);
    expect(() =>
      new FwModule({ payload: new Uint8Array([1]), bssSize: -1 }).encode(),
    ).toThrow(/bss_size out of range/);
  });

  it("validate reports out-of-range header fields", () => {
    const problems = new FwModule({
      payload: new Uint8Array([1]),
      abiVersion: 70000,
    }).validate();
    expect(problems.some((p) => p.includes("abi_version out of range"))).toBe(
      true,
    );
  });

  it("validate flags trailing bytes after the payload", () => {
    const blob = new FwModule({
      payload: new Uint8Array([10, 20, 30, 40]),
      arch: Arch.HostX86,
    }).encode();
    const padded = new Uint8Array(blob.length + 3);
    padded.set(blob);
    const problems = decodeFwmod(padded).validate();
    expect(problems.some((p) => p.includes("trailing"))).toBe(true);
  });

  it("coerces an unrecognized arch byte to Unknown (matches Python)", () => {
    const blob = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4]),
      arch: Arch.HostX86,
    }).encode();
    blob[8] = 7; // arch byte outside the known set (CRC covers only the payload)
    const m = decodeFwmod(blob);
    expect(m.arch).toBe(Arch.Unknown);
    expect(m.validate()).toEqual([]);
  });
});
