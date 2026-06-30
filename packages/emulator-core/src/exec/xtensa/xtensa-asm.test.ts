import { describe, expect, it } from "vitest";
import { decodeXtensa } from "./xtensa-decode.js";
import { xasm } from "./xtensa-asm.js";

const bytes = (b: number[]) => Uint8Array.from(b);

describe("xtensa assembler — matches real/ground-truth bytes", () => {
  it("reproduces ground-truth encodings", () => {
    expect(xasm.add(3, 2, 1)).toEqual([0x10, 0x32, 0x80]);
    expect(xasm.addi(11, 1, -2)).toEqual([0xb2, 0xc1, 0xfe]);
    expect(xasm.abs(7, 9)).toEqual([0x90, 0x71, 0x60]);
    expect(xasm.addN(9, 5, 3)).toEqual([0x3a, 0x95]);
    expect(xasm.retN()).toEqual([0x0d, 0xf0]);
    expect(xasm.memw()).toEqual([0xc0, 0x20, 0x00]);
  });

  it("reproduces real gcc density bytes (movi.n a8,-7 = 7c 98; movi.n a11,8 = 0c 8b)", () => {
    expect(xasm.moviN(8, -7)).toEqual([0x7c, 0x98]);
    expect(xasm.moviN(11, 8)).toEqual([0x0c, 0x8b]);
    expect(xasm.l32iN(8, 8, 32)).toEqual([0x88, 0x88]); // l32i.n a8,a8,32 from hello.c
  });
});

describe("xtensa assembler ⇄ decoder round-trip", () => {
  it("register/immediate instructions round-trip", () => {
    const cases: Array<[number[], Partial<ReturnType<typeof decodeXtensa>>]> = [
      [xasm.add(4, 5, 6), { mnemonic: "add", r: 4, s: 5, t: 6 }],
      [xasm.sub(4, 5, 6), { mnemonic: "sub", r: 4, s: 5, t: 6 }],
      [xasm.and(1, 2, 3), { mnemonic: "and", r: 1, s: 2, t: 3 }],
      [xasm.or(1, 2, 3), { mnemonic: "or", r: 1, s: 2, t: 3 }],
      [xasm.xor(1, 2, 3), { mnemonic: "xor", r: 1, s: 2, t: 3 }],
      [xasm.neg(7, 8), { mnemonic: "neg", r: 7, t: 8 }],
      [xasm.addi(3, 4, -5), { mnemonic: "addi", t: 3, s: 4, imm: -5 }],
      [xasm.movi(2, -1), { mnemonic: "movi", t: 2, imm: -1 }],
      [xasm.movi(5, 2000), { mnemonic: "movi", t: 5, imm: 2000 }],
      [xasm.l32i(6, 7, 16), { mnemonic: "l32i", t: 6, s: 7, imm: 16 }],
      [xasm.s32i(6, 7, 1020), { mnemonic: "s32i", t: 6, s: 7, imm: 1020 }],
      [xasm.l32iN(3, 2, 12), { mnemonic: "l32i.n", t: 3, s: 2, imm: 12 }],
      [xasm.s32iN(3, 2, 60), { mnemonic: "s32i.n", t: 3, s: 2, imm: 60 }],
      [xasm.addN(9, 5, 3), { mnemonic: "add.n", r: 9, s: 5, t: 3 }],
      [xasm.addiN(8, 8, -1), { mnemonic: "addi.n", r: 8, s: 8, imm: -1 }],
      [xasm.addiN(8, 8, 5), { mnemonic: "addi.n", r: 8, s: 8, imm: 5 }],
      [xasm.movN(4, 9), { mnemonic: "mov.n", s: 4, t: 9 }],
      [xasm.moviN(7, -7), { mnemonic: "movi.n", s: 7, imm: -7 }],
      [xasm.moviN(7, 42), { mnemonic: "movi.n", s: 7, imm: 42 }],
      [xasm.callx0(8), { mnemonic: "callx0", s: 8 }],
      [xasm.ret(), { mnemonic: "ret" }],
    ];
    for (const [b, expected] of cases) {
      expect(decodeXtensa(bytes(b))).toMatchObject(expected);
    }
  });

  it("PC-relative instructions round-trip their targets", () => {
    const pc = 0x40; // an arbitrary instruction address
    expect(decodeXtensa(bytes(xasm.j(0x20, pc)), 0, pc).target).toBe(0x20);
    expect(decodeXtensa(bytes(xasm.j(0x80, pc)), 0, pc).target).toBe(0x80);
    expect(decodeXtensa(bytes(xasm.call0(0x100, pc)), 0, pc).target).toBe(0x100);
    expect(decodeXtensa(bytes(xasm.beqzN(3, 0x4e, pc)), 0, pc)).toMatchObject({
      mnemonic: "beqz.n",
      s: 3,
      target: 0x4e,
    });
    expect(decodeXtensa(bytes(xasm.bnezN(3, 0x30, pc)), 0, pc)).toMatchObject({
      mnemonic: "bnez.n",
      s: 3,
      target: 0x30,
    });
    // L32R literal is always backward + word-aligned.
    const lit = 0x3c; // word-aligned, < pc
    expect(decodeXtensa(bytes(xasm.l32r(2, lit, pc)), 0, pc)).toMatchObject({
      mnemonic: "l32r",
      t: 2,
      target: lit,
    });
  });
});
