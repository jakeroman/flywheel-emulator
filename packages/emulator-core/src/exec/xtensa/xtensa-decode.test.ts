import { describe, expect, it } from "vitest";
import { decodeXtensa } from "./xtensa-decode.js";

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

  it("L32R literal base is pc&~3, not (pc+3)&~3, at an unaligned PC", () => {
    // imm16=0xfffe (−2 words); at pc=0x42 → base 0x40, target 0x40 - 8 = 0x38.
    // The old (pc+3)&~3 formula would wrongly give 0x44 - 8 = 0x3c.
    const i = decodeXtensa(u8(0x21, 0xfe, 0xff), 0, 0x42);
    expect(i.mnemonic).toBe("l32r");
    expect(i.target).toBe(0x38);
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
