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
  /** Computed immediate/offset value (sign-extended or scaled per mnemonic).
   *  For immediate branches (beqi/blti/…) this is the B4CONST/B4CONSTU value;
   *  for bbci/bbsi the bit number; for shifts/extui the shift amount. */
  imm: number;
  /** Secondary immediate, currently only EXTUI's field width (1..16 bits). */
  imm2: number;
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
 * B4CONST — the 16-entry immediate table BEQI/BNEI/BLTI/BGEI select with their
 * r field (NOT a linear immediate). B4CONSTU is the unsigned variant used by
 * BLTUI/BGEUI (entries 0/1 are 32768/65536; the rest match). Pinned against the
 * toolchain assembler (e.g. `beqi a3,5` → r=5, `bgeui a3,0x8000` → r=0).
 */
const B4CONST = [
  -1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256,
] as const;
const B4CONSTU = [
  32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256,
] as const;

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
    imm2: 0,
    target: 0,
    word,
    ...extra,
  });

  switch (op0) {
    case 0x0: {
      // RRR / CALLX / system. Match the specific masked patterns first.
      // CALLX/JX/RET share op0=0,op1=0,op2=0,r=0; the t field selects and the
      // operand is a[s]: RET=0x8 (→a0), JX=0xa (→a[s]), CALLX0=0xc (→a[s]).
      // (RETW=0x9, CALLX4/8/12=0xd/e/f are windowed — absent under call0.)
      const callx = word & 0xfff0ff; // op0..op2 with the s register masked out
      if (callx === 0x0000c0) return make("callx0"); // CALLX0 a[s]
      if (callx === 0x0000a0) return make("jx"); // JX a[s]
      if (callx === 0x000080) return make("ret"); // RET → a0 (s=0)
      if (word === 0x0020c0) return make("memw");
      if (word === 0x0020f0) return make("nop");
      if (op1 === 0x0) {
        // RST0: logical / add-sub / shift-amount setup.
        switch (op2) {
          case 0x1:
            return make("and");
          case 0x2:
            return make("or");
          case 0x3:
            return make("xor");
          case 0x4:
            // Shift-amount setup (sets SAR from AR[s]): r=0 SSR, r=1 SSL.
            if (r === 0x0) return make("ssr");
            if (r === 0x1) return make("ssl");
            return make("?ill");
          case 0x6:
            return make(s === 0 ? "neg" : "abs"); // op2=6: NEG (s=0) / ABS (s=1)
          case 0x8:
            return make("add");
          case 0xc:
            return make("sub");
        }
      }
      if (op1 === 0x1) {
        // RST1: shifts. SLLI/SRAI carry a 5-bit amount split across op2's low
        // bit and t (SLLI) or s (SRAI); SRLI a 4-bit amount in s. SLL/SRL/SRA
        // are variable (shift by SAR).
        if (op2 <= 0x1) {
          const sa = ((op2 & 1) << 4) | t; // 1..31
          return make("slli", { imm: 32 - sa }); // dest=r, src=s, shift=32-sa
        }
        if (op2 <= 0x3) {
          const sa = ((op2 & 1) << 4) | s; // 0..31
          return make("srai", { imm: sa }); // dest=r, src=t
        }
        switch (op2) {
          case 0x4:
            return make("srli", { imm: s }); // dest=r, src=t, sa=s (0..15)
          case 0x9:
            return make("srl"); // dest=r, src=t, by SAR
          case 0xa:
            return make("sll"); // dest=r, src=s, by SAR
          case 0xb:
            return make("sra"); // dest=r, src=t, by SAR
        }
        return make("?ill");
      }
      if (op1 === 0x2) {
        // RST2: 32-bit multiply (low/high words) + integer divide/remainder.
        // All dest=r, src1(dividend)=s, src2(divisor)=t.
        switch (op2) {
          case 0x8:
            return make("mull"); // low 32 bits
          case 0xa:
            return make("muluh"); // high 32, unsigned
          case 0xb:
            return make("mulsh"); // high 32, signed
          case 0xc:
            return make("quou"); // unsigned quotient
          case 0xd:
            return make("quos"); // signed quotient
          case 0xe:
            return make("remu"); // unsigned remainder
          case 0xf:
            return make("rems"); // signed remainder
        }
        return make("?ill");
      }
      if (op1 === 0x3) {
        // RST3: min/max, conditional moves, sign-extend. (dest=r, srcs s,t)
        switch (op2) {
          case 0x2:
            return make("sext", { imm: t + 7 }); // sign-extend AR[s] from bit t+7
          case 0x4:
            return make("min");
          case 0x5:
            return make("max");
          case 0x6:
            return make("minu");
          case 0x7:
            return make("maxu");
          case 0x8:
            return make("moveqz"); // AR[r]=AR[s] if AR[t]==0
          case 0x9:
            return make("movnez");
          case 0xa:
            return make("movltz");
          case 0xb:
            return make("movgez");
        }
        return make("?ill");
      }
      if (op1 === 0x4 || op1 === 0x5) {
        // EXTUI: AR[r] = (AR[t] >> shiftimm) & ((1<<nbits)-1).
        const shiftimm = ((op1 & 1) << 4) | s; // 0..31
        return make("extui", { imm: shiftimm, imm2: op2 + 1 }); // dest=r, src=t
      }
      return make("?ill");
    }

    case 0x1: {
      // L32R (RI16): AR[t] = mem32(literal). The 16-bit imm is a negative word
      // offset from the base (PC+3) with its low 2 bits cleared — i.e. the
      // next-instruction address rounded down to a word. This matches QEMU
      // (((pc+3)&~3) + (imm<<2)) and real gcc output: an L32R at an UNALIGNED PC
      // (routine after a 16-bit .n instruction) uses (PC+3)&~3, not PC&~3. ext
      // is already a multiple of 4, so adding it can't disturb the alignment.
      const ext = (imm16 | 0xffff0000) << 2;
      const target = (((((pc >>> 0) + 3) & ~3) >>> 0) + ext) >>> 0;
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
        case 0x9:
          return make("l16si", { imm: imm8 << 1 }); // signed 16-bit load
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
      // op0=6 multiplexes on the low 2 bits of t: 0=J (byte offset), 1=BRI12
      // zero-compare, 2=BRI8 signed-immediate, 3=BRI8 unsigned-immediate. The
      // upper 2 bits of t pick which of the 4 branches within a format. reg=s,
      // target = PC+4+offset.
      const n = t & 0x3;
      if (n === 0) {
        const target = (pc + 4 + signExtend(offset18, 18)) >>> 0;
        return make("j", { target });
      }
      const which = (t >> 2) & 0x3;
      if (n === 1) {
        // BRI12: 12-bit signed offset at [23:12]; compare AR[s] to zero.
        const target = (pc + 4 + signExtend((word >> 12) & 0xfff, 12)) >>> 0;
        const mn = ["beqz", "bnez", "bltz", "bgez"][which] as string;
        return make(mn, { target });
      }
      // BRI8 immediate: 8-bit signed offset; compare AR[s] to a B4CONST(U) value
      // selected by the r field.
      const target = (pc + 4 + signExtend(imm8, 8)) >>> 0;
      if (n === 2) {
        const mn = ["beqi", "bnei", "blti", "bgei"][which] as string;
        return make(mn, { imm: B4CONST[r], target });
      }
      // n === 3: only BLTUI (which=2) / BGEUI (which=3) exist.
      if (which === 2) return make("bltui", { imm: B4CONSTU[r], target });
      if (which === 3) return make("bgeui", { imm: B4CONSTU[r], target });
      return make("?ill");
    }

    case 0x7: {
      // BRI8 register/bit branches: r selects the comparison, 8-bit signed
      // offset, operands AR[s] and AR[t]. BBCI/BBSI replace AR[t] with a 5-bit
      // bit number (bbi[4] = r&1).
      const target = (pc + 4 + signExtend(imm8, 8)) >>> 0;
      switch (r) {
        case 0x0:
          return make("bnone", { target });
        case 0x1:
          return make("beq", { target });
        case 0x2:
          return make("blt", { target });
        case 0x3:
          return make("bltu", { target });
        case 0x4:
          return make("ball", { target });
        case 0x5:
          return make("bbc", { target });
        case 0x6:
        case 0x7:
          return make("bbci", { imm: ((r & 1) << 4) | t, target });
        case 0x8:
          return make("bany", { target });
        case 0x9:
          return make("bne", { target });
        case 0xa:
          return make("bge", { target });
        case 0xb:
          return make("bgeu", { target });
        case 0xc:
          return make("bnall", { target });
        case 0xd:
          return make("bbs", { target });
        case 0xe:
        case 0xf:
          return make("bbsi", { imm: ((r & 1) << 4) | t, target });
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
      // BEQZ.N/BNEZ.N: the 6-bit offset is UNSIGNED (forward-only, +4..+67) —
      // unlike J and the 12-bit BEQZ/BNEZ which are signed. Do NOT sign-extend.
      const imm6 = (((b0 >> 4) & 0x3) << 4) | ((b1 >> 4) & 0xf);
      const target = (pc + 4 + imm6) >>> 0;
      return make(t <= 0xb ? "beqz.n" : "bnez.n", { target }); // branch on AR[s]
    }

    case 0xd: {
      // Narrow MOV / special.
      if (word === 0xf00d) return make("ret.n");
      if (word === 0xf03d) return make("nop.n");
      if (r === 0x0) return make("mov.n"); // RRRN: AR[t] = AR[s] (dest=t, src=s)
      return make("?ill");
    }
  }

  return make("?ill");
}
