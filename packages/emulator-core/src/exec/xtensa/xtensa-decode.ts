/**
 * Xtensa LX7 instruction decoder (ESP32-S3, call0 ABI subset).
 *
 * The first, load-bearing piece of the hardware-faithful backend: a pure decode
 * of the instruction subset gcc -Os -mabi=call0 emits. A single wrong encoding
 * silently corrupts execution, so every field rule and opcode here is pinned to
 * authoritative sources — the Xtensa ISA Reference Manual cross-checked against
 * the binja-xtensa / ida-xtensa decoders and QEMU's target/xtensa — and the
 * decoder is validated against ground-truth bytes in xtensa-decode.test.ts.
 *
 * Xtensa is little-endian. Base instructions are 24-bit (3 bytes); the Code
 * Density Option adds 16-bit (2-byte) ".n" forms (heavily used by -Os). The
 * length is a pure function of op0 (the low nibble of byte0): op0 in 0x8..0xD
 * is a 16-bit instruction, everything else is 24-bit.
 *
 * NOTE: execution is NOT here (that's the CPU core). This only structurally
 * decodes + computes immediates/targets. Items the research flagged
 * medium-confidence (MOVI.N immediate packing, narrow-branch offset packing) are
 * marked below and will be re-checked via the assembler round-trip + real
 * gcc/godbolt output before the interpreter is trusted.
 */

export interface XtensaInsn {
  /** Lowercase mnemonic, or "?ill" for an unrecognized/illegal slot. */
  mnemonic: string;
  /** Instruction length in bytes (2 for narrow, 3 for base). */
  length: 2 | 3;
  /** The s/t/r register fields (meaning depends on the instruction). */
  s: number;
  t: number;
  r: number;
  /** Computed immediate/offset value (sign-extended or scaled per mnemonic). */
  imm: number;
  /** Absolute target for PC-relative ops (branch/call target, L32R literal
   *  address); 0 for non-PC-relative instructions. */
  target: number;
  /** The raw decoded instruction word (16- or 24-bit). */
  word: number;
}

/** Sign-extend the low `bits` of `v` to a 32-bit signed JS number. */
function signExtend(v: number, bits: number): number {
  const shift = 32 - bits;
  return (v << shift) >> shift;
}

/**
 * Decode one instruction at `bytes[offset]`. `pc` is the guest address of that
 * instruction (used for PC-relative target math); it defaults to `offset` for
 * standalone decoding in tests.
 */
export function decodeXtensa(
  bytes: Uint8Array,
  offset = 0,
  pc = offset,
): XtensaInsn {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const op0 = b0 & 0xf;
  const narrow = op0 >= 0x8 && op0 <= 0xd;
  const length: 2 | 3 = narrow ? 2 : 3;
  const b2 = narrow ? 0 : (bytes[offset + 2] ?? 0);
  const word = narrow ? b0 | (b1 << 8) : b0 | (b1 << 8) | (b2 << 16);

  // Field extraction (same positions for narrow + base; op1/op2/imm* are
  // base-only but harmless to compute on a narrow word).
  const t = (word >> 4) & 0xf;
  const s = (word >> 8) & 0xf;
  const r = (word >> 12) & 0xf;
  const op1 = (word >> 16) & 0xf;
  const op2 = (word >> 20) & 0xf;
  const imm8 = (word >> 16) & 0xff;
  const imm16 = (word >> 8) & 0xffff;
  const offset18 = (word >> 6) & 0x3ffff;

  const make = (mnemonic: string, extra: Partial<XtensaInsn> = {}): XtensaInsn => ({
    mnemonic,
    length,
    s,
    t,
    r,
    imm: 0,
    target: 0,
    word,
    ...extra,
  });

  switch (op0) {
    case 0x0: {
      // RRR / CALLX / system. Match the specific masked patterns first.
      if ((word & 0xfff0ff) === 0x0000c0) return make("callx0"); // CALLX0 a[s]
      if ((word & 0xfff0ff) === 0x000080) return make(s === 0 ? "ret" : "jx"); // ret = jx a0
      if (word === 0x0020c0) return make("memw");
      if (word === 0x0020f0) return make("nop");
      if (op1 === 0x0) {
        switch (op2) {
          case 0x1:
            return make("and");
          case 0x2:
            return make("or");
          case 0x3:
            return make("xor");
          case 0x6:
            return make(s === 0 ? "neg" : "abs"); // op2=6: NEG (s=0) / ABS (s=1)
          case 0x8:
            return make("add");
          case 0xc:
            return make("sub");
        }
      }
      return make("?ill");
    }

    case 0x1: {
      // L32R (RI16): AR[t] = mem32(literal). The 16-bit imm is a negative word
      // offset from the (word-aligned) PC.
      const ext = (imm16 | 0xffff0000) << 2;
      const target = ((ext + pc + 3) & 0xfffffffc) >>> 0;
      return make("l32r", { target });
    }

    case 0x2: {
      // LSAI (RRI8): r selects the operation; imm8 is zero-extended + scaled
      // for loads/stores, sign-extended for MOVI/ADDI/ADDMI.
      switch (r) {
        case 0x0:
          return make("l8ui", { imm: imm8 });
        case 0x1:
          return make("l16ui", { imm: imm8 << 1 });
        case 0x2:
          return make("l32i", { imm: imm8 << 2 });
        case 0x4:
          return make("s8i", { imm: imm8 });
        case 0x5:
          return make("s16i", { imm: imm8 << 1 });
        case 0x6:
          return make("s32i", { imm: imm8 << 2 });
        case 0xa:
          return make("movi", { imm: signExtend((s << 8) | imm8, 12) });
        case 0xc:
          return make("addi", { imm: signExtend(imm8, 8) });
        case 0xd:
          return make("addmi", { imm: signExtend(imm8, 8) << 8 });
      }
      return make("?ill");
    }

    case 0x5: {
      // CALL group; n (bits 4-5) selects CALL0/4/8/12. call0 only uses CALL0.
      const n = (b0 >> 4) & 0x3;
      if (n === 0) {
        const target = ((pc & ~3) + 4 + (signExtend(offset18, 18) << 2)) >>> 0;
        return make("call0", { target });
      }
      return make("?ill");
    }

    case 0x6: {
      // J (n=0) uses a BYTE offset (not shifted). BRI12 zero/compare branches
      // (n!=0) are added in a later increment.
      const n = (b0 >> 4) & 0x3;
      if (n === 0) {
        const target = (pc + 4 + signExtend(offset18, 18)) >>> 0;
        return make("j", { target });
      }
      return make("?ill");
    }

    case 0x8: // L32I.N (RRRN): AR[t] = mem32(AR[s] + r*4), r zero-extended ×4.
      return make("l32i.n", { imm: r << 2 });
    case 0x9: // S32I.N
      return make("s32i.n", { imm: r << 2 });
    case 0xa: // ADD.N (RRRN): AR[r] = AR[s] + AR[t]
      return make("add.n");
    case 0xb: // ADDI.N (RRRN): AR[r] = AR[s] + (imm4==0 ? -1 : imm4); imm in t
      return make("addi.n", { imm: t === 0 ? -1 : t });

    case 0xc: {
      // ST2 narrow group: t-field selects MOVI.N (0..7) / BEQZ.N (8..11) /
      // BNEZ.N (12..15). The immediate packings are medium-confidence (flagged
      // by research) — verify via assembler round-trip + godbolt before relying.
      if (t <= 0x7) {
        const imm7 = (((b0 >> 4) & 0x7) << 4) | ((b1 >> 4) & 0xf);
        const imm = imm7 >> 5 === 0x3 ? signExtend(imm7, 7) : imm7;
        return make("movi.n", { imm }); // dest = s
      }
      const imm6 = (((b0 >> 4) & 0x3) << 4) | ((b1 >> 4) & 0xf);
      const target = (pc + 4 + signExtend(imm6, 6)) >>> 0;
      return make(t <= 0xb ? "beqz.n" : "bnez.n", { target }); // branch on AR[s]
    }

    case 0xd: {
      // Narrow MOV / special.
      if (word === 0xf00d) return make("ret.n");
      if (word === 0xf03d) return make("nop.n");
      if (r === 0x0) return make("mov.n"); // AR[s] = AR[t]
      return make("?ill");
    }
  }

  return make("?ill");
}
