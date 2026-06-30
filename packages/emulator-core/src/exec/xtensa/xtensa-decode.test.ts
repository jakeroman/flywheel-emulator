import { describe, expect, it } from "vitest";
import { decodeXtensa } from "./xtensa-decode.js";
import { REAL_DISASM } from "./real-disasm.fixture.js";

const u8 = (...b: number[]) => new Uint8Array(b);

describe("decodeXtensa — ground-truth fixtures", () => {
  // Bytes cross-verified by the ISA research (binja-xtensa / ida-xtensa / QEMU).
  it("ADD a3,a2,a1 = 10 32 80", () => {
    const i = decodeXtensa(u8(0x10, 0x32, 0x80));
    expect(i.mnemonic).toBe("add");
    expect(i.length).toBe(3);
    expect([i.r, i.s, i.t]).toEqual([3, 2, 1]); // dest=r, srcs s,t
  });

  it("ADDI a11,a1,-2 = b2 c1 fe", () => {
    const i = decodeXtensa(u8(0xb2, 0xc1, 0xfe));
    expect(i.mnemonic).toBe("addi");
    expect(i.t).toBe(11); // dest
    expect(i.s).toBe(1); // src
    expect(i.imm).toBe(-2); // sign-extended imm8
  });

  it("ABS a7,a9 = 90 71 60 (op2=6, s=1)", () => {
    const i = decodeXtensa(u8(0x90, 0x71, 0x60));
    expect(i.mnemonic).toBe("abs");
    expect(i.r).toBe(7);
    expect(i.t).toBe(9);
  });

  it("ADD.N a9,a5,a3 = 3a 95 (narrow)", () => {
    const i = decodeXtensa(u8(0x3a, 0x95));
    expect(i.mnemonic).toBe("add.n");
    expect(i.length).toBe(2);
    expect([i.r, i.s, i.t]).toEqual([9, 5, 3]);
  });

  it("RET.N = 0d f0, NOP = f0 20 00, MEMW = c0 20 00", () => {
    expect(decodeXtensa(u8(0x0d, 0xf0))).toMatchObject({
      mnemonic: "ret.n",
      length: 2,
    });
    expect(decodeXtensa(u8(0xf0, 0x20, 0x00)).mnemonic).toBe("nop");
    expect(decodeXtensa(u8(0xc0, 0x20, 0x00)).mnemonic).toBe("memw");
  });

  it("CALLX0 a4 and RET (jx a0)", () => {
    // CALLX0 a[s]: low byte 0xC0, s in byte1 low nibble.
    expect(decodeXtensa(u8(0xc0, 0x04, 0x00))).toMatchObject({
      mnemonic: "callx0",
      s: 4,
    });
    // JX a0 == RET (low byte 0x80, s=0).
    expect(decodeXtensa(u8(0x80, 0x00, 0x00)).mnemonic).toBe("ret");
  });
});

describe("decodeXtensa — immediate semantics", () => {
  it("MOVI a2,-1 sign-extends the 12-bit immediate (22 af ff)", () => {
    const i = decodeXtensa(u8(0x22, 0xaf, 0xff));
    expect(i.mnemonic).toBe("movi");
    expect(i.t).toBe(2);
    expect(i.imm).toBe(-1);
  });

  it("L32I.N a3,a2,12 zero-extends the offset ×4 (38 32)", () => {
    const i = decodeXtensa(u8(0x38, 0x32));
    expect(i.mnemonic).toBe("l32i.n");
    expect(i.t).toBe(3); // dest
    expect(i.s).toBe(2); // base
    expect(i.imm).toBe(12); // r(=3) << 2
  });

  it("L32I a5,a3,16 scales imm8 ×4", () => {
    // op0=2, r=2 (L32I), t=5, s=3, imm8=4 → offset 16.
    // word = 2 | (5<<4) | (3<<8) | (2<<12) | (4<<16) = 0x042352
    const i = decodeXtensa(u8(0x52, 0x23, 0x04));
    expect(i.mnemonic).toBe("l32i");
    expect(i.t).toBe(5);
    expect(i.s).toBe(3);
    expect(i.imm).toBe(16);
  });

  it("L32R computes a backward, word-aligned literal address", () => {
    // op0=1, t=2, imm16=0xFFFF → offset -1 word → literal at (pc&~3)-? .
    // word = 1 | (2<<4) | (0xFFFF<<8) = 0xffff21; at pc=0x20 → aligned target.
    const i = decodeXtensa(u8(0x21, 0xff, 0xff), 0, 0x20);
    expect(i.mnemonic).toBe("l32r");
    expect(i.target % 4).toBe(0); // word-aligned
    expect(i.target).toBeLessThan(0x20); // always backward
  });

  it("L32R literal base is (pc+3)&~3 at an unaligned PC (real gcc + QEMU)", () => {
    // imm16=0xfffe (−2 words); at pc=0x42 the base is (0x42+3)&~3 = 0x44, so the
    // target is 0x44 - 8 = 0x3c. (A real gcc -Os module has `l32r a2,&MODULE` at
    // pc 0x...21 whose only correct resolution uses (pc+3)&~3; PC&~3 lands a word
    // low and dispatches into string data — see exec/differential.test.ts.)
    const i = decodeXtensa(u8(0x21, 0xfe, 0xff), 0, 0x42);
    expect(i.mnemonic).toBe("l32r");
    expect(i.target).toBe(0x3c);
  });
});

describe("decodeXtensa — instruction length rule", () => {
  it("op0 0x8..0xD are 16-bit; all others 24-bit", () => {
    for (let op0 = 0; op0 <= 0xf; op0++) {
      const i = decodeXtensa(u8(op0, 0x00, 0x00));
      expect(i.length).toBe(op0 >= 0x8 && op0 <= 0xd ? 2 : 3);
    }
  });
});

describe("decodeXtensa — new instruction families (oracle-pinned operands)", () => {
  // Bytes from the toolchain assembler (xtensa-esp32s3-elf-as); see
  // real-disasm.fixture.ts for the broader corpus.
  it("SLLI a3,a4,1 → shift 1, dest=r src=s (f0 34 11)", () => {
    const i = decodeXtensa(u8(0xf0, 0x34, 0x11));
    expect([i.mnemonic, i.r, i.s, i.imm]).toEqual(["slli", 3, 4, 1]);
  });
  it("SRLI a3,a4,15 → 4-bit amount in s, src=t (40 3f 41)", () => {
    const i = decodeXtensa(u8(0x40, 0x3f, 0x41));
    expect([i.mnemonic, i.r, i.t, i.imm]).toEqual(["srli", 3, 4, 15]);
  });
  it("SRAI a3,a4,31 → 5-bit amount split op2/s (40 3f 31)", () => {
    const i = decodeXtensa(u8(0x40, 0x3f, 0x31));
    expect([i.mnemonic, i.r, i.t, i.imm]).toEqual(["srai", 3, 4, 31]);
  });
  it("EXTUI a3,a4,16,16 → shift 16, width 16 (40 30 f5)", () => {
    const i = decodeXtensa(u8(0x40, 0x30, 0xf5));
    expect([i.mnemonic, i.r, i.t, i.imm, i.imm2]).toEqual([
      "extui",
      3,
      4,
      16,
      16,
    ]);
  });
  it("SEXT a3,a4,7 → sign-bit 7, dest=r src=s (00 34 23)", () => {
    const i = decodeXtensa(u8(0x00, 0x34, 0x23));
    expect([i.mnemonic, i.r, i.s, i.imm]).toEqual(["sext", 3, 4, 7]);
  });
  it("MULL/MULSH/MULUH share op1=2, distinguished by op2", () => {
    expect(decodeXtensa(u8(0x30, 0x22, 0x82)).mnemonic).toBe("mull");
    expect(decodeXtensa(u8(0x30, 0x32, 0xb2)).mnemonic).toBe("mulsh");
    expect(decodeXtensa(u8(0x30, 0x22, 0xa2)).mnemonic).toBe("muluh");
  });
  it("BEQI a3,5 → B4CONST[5]=5 (26 53 26)", () => {
    const i = decodeXtensa(u8(0x26, 0x53, 0x26), 0, 0x3e);
    expect([i.mnemonic, i.s, i.imm, i.target]).toEqual(["beqi", 3, 5, 0x68]);
  });
  it("BGEUI a3,0x8000 → B4CONSTU[0]=32768 (f6 03 17)", () => {
    const i = decodeXtensa(u8(0xf6, 0x03, 0x17), 0, 0x4d);
    expect([i.mnemonic, i.s, i.imm]).toEqual(["bgeui", 3, 32768]);
  });
  it("BEQZ/BLTZ/BGEZ select on (t>>2) with a signed 12-bit offset", () => {
    expect(decodeXtensa(u8(0x16, 0xc3, 0xff), 0, 0x33)).toMatchObject({
      mnemonic: "beqz",
      target: 0x33,
    });
    expect(decodeXtensa(u8(0x96, 0x73, 0xff), 0, 0x38)).toMatchObject({
      mnemonic: "bltz",
      target: 0x33,
    });
  });
  it("BNE / BGEU reg-reg branch select on r (op0=7)", () => {
    const bne = decodeXtensa(u8(0x47, 0x93, 0x11), 0, 0x53);
    expect([bne.mnemonic, bne.s, bne.t, bne.target]).toEqual([
      "bne",
      3,
      4,
      0x68,
    ]);
  });
  it("BBSI a3,31 → bit 31 = (r&1)<<4 | t (f7 f3 ff)", () => {
    const i = decodeXtensa(u8(0xf7, 0xf3, 0xff), 0, 0x65);
    expect([i.mnemonic, i.s, i.imm, i.target]).toEqual(["bbsi", 3, 31, 0x68]);
  });
  it("MOV.N a2,a8 (a2=a8) → dest=t=2, src=s=8 (2d 08)", () => {
    // RRRN MOV.N is AR[t] = AR[s]; the destination is the t-field, not s.
    const i = decodeXtensa(u8(0x2d, 0x08));
    expect([i.mnemonic, i.t, i.s]).toEqual(["mov.n", 2, 8]);
  });
  it("JX a7 = a0 07 00 (t=0xa selects JX, operand a[s])", () => {
    // Real gcc tail-calls with JX (t=0xa), distinct from RET (t=8)/CALLX0 (0xc).
    const i = decodeXtensa(u8(0xa0, 0x07, 0x00));
    expect([i.mnemonic, i.s]).toEqual(["jx", 7]);
    expect(decodeXtensa(u8(0x80, 0x00, 0x00)).mnemonic).toBe("ret");
    expect(decodeXtensa(u8(0xc0, 0x09, 0x00))).toMatchObject({
      mnemonic: "callx0",
      s: 9,
    });
  });
  it("divide/remainder family (op1=2): quou/quos/remu/rems by op2", () => {
    // quou a2,a3,a4 = c2 23 40 (value); memory LE [40 23 c2].
    expect(decodeXtensa(u8(0x40, 0x23, 0xc2))).toMatchObject({
      mnemonic: "quou",
      r: 2,
      s: 3,
      t: 4,
    });
    expect(decodeXtensa(u8(0x40, 0x23, 0xd2)).mnemonic).toBe("quos");
    expect(decodeXtensa(u8(0x40, 0x23, 0xe2)).mnemonic).toBe("remu");
    expect(decodeXtensa(u8(0x40, 0x23, 0xf2)).mnemonic).toBe("rems");
  });
});

describe("decodeXtensa — real toolchain disassembly conformance", () => {
  it("reproduces objdump's mnemonic for every -Os / probe instruction", () => {
    const misclassified = REAL_DISASM.filter(
      (row) => decodeXtensa(Uint8Array.from(row.bytes)).mnemonic !== row.mnemonic,
    ).map((row) => ({
      asm: row.asm,
      got: decodeXtensa(Uint8Array.from(row.bytes)).mnemonic,
    }));
    expect(misclassified).toEqual([]);
  });

  it("never returns ?ill for real toolchain output", () => {
    const illegal = REAL_DISASM.filter(
      (row) => decodeXtensa(Uint8Array.from(row.bytes)).mnemonic === "?ill",
    );
    expect(illegal).toEqual([]);
  });

  it("decodes the expected length for every row", () => {
    for (const row of REAL_DISASM) {
      expect(decodeXtensa(Uint8Array.from(row.bytes)).length).toBe(
        row.bytes.length,
      );
    }
  });
});
