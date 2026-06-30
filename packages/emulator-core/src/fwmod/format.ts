/**
 * The .fwmod container codec (reader + writer).
 *
 * This is the TypeScript half of a format defined once in docs/fwmod-format.md
 * and implemented twice (here, and in Python at tools/fwmod/fwmod/format.py). A
 * committed golden fixture is decoded by both sides' tests so they cannot drift.
 *
 * The emulator uses this to load, validate, and inspect native modules.
 * Executing them is Phase 5; here we parse and integrity-check the container.
 */

import { crc32 } from "./crc32.js";

export const MAGIC = "FWMD";
export const FORMAT_VERSION = 1;
export const ABI_VERSION = 1;
export const HEADER_SIZE = 32;

export const FLAG_PIC = 0x01;

/** Target architecture (`arch` byte). Host/wasm are dev targets. */
export const Arch = {
  Unknown: 0,
  XtensaLx7: 1, // ESP32-S3 — the real hardware target
  HostX86: 2,
  HostX86_64: 3,
  Wasm32: 4,
} as const;
export type Arch = (typeof Arch)[keyof typeof Arch];

const ARCH_NAMES: Readonly<Record<number, string>> = {
  0: "unknown",
  1: "xtensa-lx7",
  2: "host-x86",
  3: "host-x86_64",
  4: "wasm32",
};

export function archName(arch: number): string {
  return ARCH_NAMES[arch] ?? `arch#${arch}`;
}

export interface FwModuleFields {
  payload: Uint8Array;
  arch?: number;
  abiVersion?: number;
  formatVersion?: number;
  flags?: number;
  bssSize?: number;
  entryOffset?: number;
  loadAddr?: number;
  reserved?: number;
  /** CRC stored in the file. Set by decode(); may differ from the recomputed
   *  CRC for a corrupt file. encode() always writes a fresh CRC. */
  storedCrc32?: number | null;
  /** Total input length, set by decode() so validate() can flag trailing bytes.
   *  null for constructor-built modules. */
  sourceSize?: number | null;
}

/** A decoded .fwmod: its header fields plus the raw payload. */
export class FwModule {
  readonly payload: Uint8Array;
  readonly arch: number;
  readonly abiVersion: number;
  readonly formatVersion: number;
  readonly flags: number;
  readonly bssSize: number;
  readonly entryOffset: number;
  readonly loadAddr: number;
  readonly reserved: number;
  readonly storedCrc32: number | null;
  readonly sourceSize: number | null;

  constructor(fields: FwModuleFields) {
    this.payload = fields.payload;
    this.arch = fields.arch ?? Arch.Unknown;
    this.abiVersion = fields.abiVersion ?? ABI_VERSION;
    this.formatVersion = fields.formatVersion ?? FORMAT_VERSION;
    this.flags = fields.flags ?? 0;
    this.bssSize = fields.bssSize ?? 0;
    this.entryOffset = fields.entryOffset ?? 0;
    this.loadAddr = fields.loadAddr ?? 0;
    this.reserved = fields.reserved ?? 0;
    this.storedCrc32 = fields.storedCrc32 ?? null;
    this.sourceSize = fields.sourceSize ?? null;
  }

  /** (name, value, max) for every fixed-width header field. */
  private fieldRanges(): ReadonlyArray<readonly [string, number, number]> {
    return [
      ["format_version", this.formatVersion, 0xffff],
      ["abi_version", this.abiVersion, 0xffff],
      ["reserved", this.reserved, 0xffff],
      ["arch", this.arch, 0xff],
      ["flags", this.flags, 0xff],
      ["code_size", this.codeSize, 0xffffffff],
      ["bss_size", this.bssSize, 0xffffffff],
      ["entry_offset", this.entryOffset, 0xffffffff],
      ["load_addr", this.loadAddr, 0xffffffff],
    ];
  }

  get codeSize(): number {
    return this.payload.length;
  }

  get computedCrc32(): number {
    return crc32(this.payload);
  }

  get archLabel(): string {
    return archName(this.arch);
  }

  /** Serialize to bytes, computing the payload CRC fresh. Throws on an
   *  out-of-range field rather than silently truncating it (matches the
   *  Python writer, which raises). */
  encode(): Uint8Array {
    for (const [name, value, hi] of this.fieldRanges()) {
      if (!Number.isInteger(value) || value < 0 || value > hi) {
        throw new Error(`${name} out of range: ${value} (allowed 0..${hi})`);
      }
    }
    const out = new Uint8Array(HEADER_SIZE + this.codeSize);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
    view.setUint16(4, this.formatVersion, true);
    view.setUint16(6, this.abiVersion, true);
    out[8] = this.arch;
    out[9] = this.flags;
    view.setUint16(10, this.reserved, true);
    view.setUint32(12, this.codeSize, true);
    view.setUint32(16, this.bssSize, true);
    view.setUint32(20, this.entryOffset, true);
    view.setUint32(24, this.loadAddr, true);
    view.setUint32(28, this.computedCrc32, true);
    out.set(this.payload, HEADER_SIZE);
    return out;
  }

  /** Return a list of problems; an empty list means a loadable module. */
  validate(): string[] {
    const problems: string[] = [];
    for (const [name, value, hi] of this.fieldRanges()) {
      if (!Number.isInteger(value) || value < 0 || value > hi) {
        problems.push(`${name} out of range: ${value} (allowed 0..${hi})`);
      }
    }
    if (this.formatVersion !== FORMAT_VERSION) {
      problems.push(
        `unsupported format_version ${this.formatVersion} (this build reads ${FORMAT_VERSION})`,
      );
    }
    if (this.reserved !== 0) {
      problems.push(`reserved field must be 0, got ${this.reserved}`);
    }
    if (this.codeSize < 1) {
      problems.push("empty payload (code_size must be >= 1)");
    }
    if (this.entryOffset >= this.codeSize) {
      problems.push(
        `entry_offset ${this.entryOffset} is outside the ${this.codeSize}-byte payload`,
      );
    }
    if (this.storedCrc32 !== null && this.storedCrc32 !== this.computedCrc32) {
      problems.push(
        `crc32 mismatch: header says ${hex(this.storedCrc32)}, payload is ${hex(this.computedCrc32)}`,
      );
    }
    if (
      this.sourceSize !== null &&
      this.sourceSize !== HEADER_SIZE + this.codeSize
    ) {
      const trailing = this.sourceSize - HEADER_SIZE - this.codeSize;
      problems.push(
        `file is ${this.sourceSize} bytes, expected ${HEADER_SIZE + this.codeSize} (${trailing > 0 ? "+" : ""}${trailing} trailing byte(s) after the payload)`,
      );
    }
    return problems;
  }
}

/**
 * Parse a .fwmod buffer. Lenient: parses any 32+ byte buffer with the right
 * magic so tooling can inspect malformed files. Throws on a structurally
 * impossible buffer (too small, bad magic, truncated payload). Use validate()
 * to gate loading.
 */
export function decodeFwmod(data: Uint8Array): FwModule {
  if (data.length < HEADER_SIZE) {
    throw new Error(
      `too small to be a .fwmod: ${data.length} bytes (need >= ${HEADER_SIZE})`,
    );
  }
  // DataView over the exact region the array views (handles subarray offsets).
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let magic = "";
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(data[i]);
  if (magic !== MAGIC) {
    throw new Error(`bad magic ${JSON.stringify(magic)} (expected "${MAGIC}")`);
  }

  const formatVersion = view.getUint16(4, true);
  const abiVersion = view.getUint16(6, true);
  // Coerce an unrecognized arch byte to Unknown, matching the Python decoder.
  const rawArch = data[8];
  const arch = rawArch in ARCH_NAMES ? rawArch : Arch.Unknown;
  const flags = data[9];
  const reserved = view.getUint16(10, true);
  const codeSize = view.getUint32(12, true);
  const bssSize = view.getUint32(16, true);
  const entryOffset = view.getUint32(20, true);
  const loadAddr = view.getUint32(24, true);
  const storedCrc32 = view.getUint32(28, true);

  const available = data.length - HEADER_SIZE;
  if (codeSize > available) {
    throw new Error(
      `truncated: header claims ${codeSize}-byte payload but only ${available} bytes follow the header`,
    );
  }
  const payload = data.subarray(HEADER_SIZE, HEADER_SIZE + codeSize);

  return new FwModule({
    payload,
    arch,
    abiVersion,
    formatVersion,
    flags,
    bssSize,
    entryOffset,
    loadAddr,
    reserved,
    storedCrc32,
    sourceSize: data.length,
  });
}

function hex(n: number): string {
  return `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
}
