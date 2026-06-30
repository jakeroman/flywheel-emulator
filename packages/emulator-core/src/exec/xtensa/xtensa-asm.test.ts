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

  it("reproduces toolchain-assembler bytes for the extended families", () => {
    // Memory (little-endian) bytes captured from xtensa-esp32s3-elf-as.
    expect(xasm.slli(3, 4, 1)).toEqual([0xf0, 0x34, 0x11]);
    expect(xasm.srli(3, 4, 15)).toEqual([0x40, 0x3f, 0x41]);
    expect(xasm.srai(3, 4, 31)).toEqual([0x40, 0x3f, 0x31]);
    expect(xasm.sll(3, 4)).toEqual([0x00, 0x34, 0xa1]);
    expect(xasm.extui(3, 4, 16, 16)).toEqual([0x40, 0x30, 0xf5]);
    expect(xasm.sext(3, 4, 7)).toEqual([0x00, 0x34, 0x23]);
    expect(xasm.mull(2, 2, 3)).toEqual([0x30, 0x22, 0x82]);
    expect(xasm.quou(2, 3, 4)).toEqual([0x40, 0x23, 0xc2]);
    expect(xasm.rems(2, 3, 4)).toEqual([0x40, 0x23, 0xf2]);
    expect(xasm.jx(7)).toEqual([0xa0, 0x07, 0x00]);
    expect(xasm.min(8, 3, 2)).toEqual([0x20, 0x83, 0x43]);
    expect(xasm.movnez(4, 3, 2)).toEqual([0x20, 0x43, 0x93]);
    expect(xasm.l16si(3, 4, 0)).toEqual([0x32, 0x94, 0x00]);
    // Branches (operands carry their own PC).
    expect(xasm.beq(3, 4, 0x68, 0x50)).toEqual([0x47, 0x13, 0x14]);
    expect(xasm.beqi(3, 5, 0x68, 0x3e)).toEqual([0x26, 0x53, 0x26]);
    expect(xasm.bgeui(3, 0x8000, 0x68, 0x4d)).toEqual([0xf6, 0x03, 0x17]);
    expect(xasm.bbsi(3, 31, 0x68, 0x65)).toEqual([0xf7, 0xf3, 0xff]);
    expect(xasm.beqz(3, 0x33, 0x33)).toEqual([0x16, 0xc3, 0xff]);
    // MOV.N a2,a8 (a2=a8): dest=t, src=s — pins the operand order to the toolchain.
    expect(xasm.movN(2, 8)).toEqual([0x2d, 0x08]);
    expect(xasm.movN(8, 3)).toEqual([0x8d, 0x03]);
  });

  it("rejects out-of-table immediates and out-of-range offsets", () => {
    expect(() => xasm.beqi(3, 9, 0x10, 0)).toThrow(/B4CONST/); // 9 not in table
    expect(() => xasm.beq(3, 4, 0x1000, 0)).toThrow(/8-bit range/); // far target
    expect(() => xasm.beqz(3, 0x4000, 0)).toThrow(/12-bit range/);
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
      // MOV.N dest,src = AR[dest]=AR[src]: dest lands in t, src in s.
      [xasm.movN(4, 9), { mnemonic: "mov.n", t: 4, s: 9 }],
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
    // Narrow branches are forward-only (unsigned 6-bit). The +44 case has bit 5
    // set, so a (wrong) sign-extend would decode it backward — assert forward.
    expect(decodeXtensa(bytes(xasm.beqzN(3, 0x4e, pc)), 0, pc)).toMatchObject({
      mnemonic: "beqz.n",
      s: 3,
      target: 0x4e,
    });
    expect(decodeXtensa(bytes(xasm.bnezN(3, pc + 4 + 44, pc)), 0, pc)).toMatchObject({
      mnemonic: "bnez.n",
      s: 3,
      target: pc + 4 + 44,
    });
    expect(() => xasm.bnezN(3, pc - 8, pc)).toThrow(/out of range/); // backward rejected

    // L32R: backward + word-aligned, base = (pc+3) & ~3 (test at an UNALIGNED pc).
    expect(decodeXtensa(bytes(xasm.l32r(2, 0x3c, pc)), 0, pc)).toMatchObject({
      mnemonic: "l32r",
      t: 2,
      target: 0x3c,
    });
    const upc = 0x42; // unaligned
    expect(decodeXtensa(bytes(xasm.l32r(2, 0x38, upc)), 0, upc)).toMatchObject({
      mnemonic: "l32r",
      t: 2,
      target: 0x38,
    });
  });

  it("extended families round-trip through the decoder", () => {
    const cases: Array<[number[], Partial<ReturnType<typeof decodeXtensa>>]> = [
      [xasm.slli(3, 4, 7), { mnemonic: "slli", r: 3, s: 4, imm: 7 }],
      [xasm.srli(3, 4, 9), { mnemonic: "srli", r: 3, t: 4, imm: 9 }],
      [xasm.srai(3, 4, 17), { mnemonic: "srai", r: 3, t: 4, imm: 17 }],
      [xasm.srl(3, 4), { mnemonic: "srl", r: 3, t: 4 }],
      [xasm.sll(3, 4), { mnemonic: "sll", r: 3, s: 4 }],
      [xasm.ssl(5), { mnemonic: "ssl", s: 5 }],
      [xasm.ssr(5), { mnemonic: "ssr", s: 5 }],
      [xasm.extui(3, 4, 5, 12), { mnemonic: "extui", r: 3, t: 4, imm: 5, imm2: 12 }],
      [xasm.sext(3, 4, 15), { mnemonic: "sext", r: 3, s: 4, imm: 15 }],
      [xasm.mull(2, 3, 4), { mnemonic: "mull", r: 2, s: 3, t: 4 }],
      [xasm.muluh(2, 3, 4), { mnemonic: "muluh", r: 2, s: 3, t: 4 }],
      [xasm.mulsh(2, 3, 4), { mnemonic: "mulsh", r: 2, s: 3, t: 4 }],
      [xasm.quou(2, 3, 4), { mnemonic: "quou", r: 2, s: 3, t: 4 }],
      [xasm.quos(2, 3, 4), { mnemonic: "quos", r: 2, s: 3, t: 4 }],
      [xasm.remu(2, 3, 4), { mnemonic: "remu", r: 2, s: 3, t: 4 }],
      [xasm.rems(2, 3, 4), { mnemonic: "rems", r: 2, s: 3, t: 4 }],
      [xasm.jx(6), { mnemonic: "jx", s: 6 }],
      [xasm.minu(2, 3, 4), { mnemonic: "minu", r: 2, s: 3, t: 4 }],
      [xasm.moveqz(2, 3, 4), { mnemonic: "moveqz", r: 2, s: 3, t: 4 }],
      [xasm.l16si(6, 7, 40), { mnemonic: "l16si", t: 6, s: 7, imm: 40 }],
    ];
    for (const [b, expected] of cases) {
      expect(decodeXtensa(bytes(b))).toMatchObject(expected);
    }
  });

  it("branch encoders round-trip targets + immediates (incl. backward)", () => {
    const pc = 0x80;
    // Zero-compare BRI12, both directions.
    expect(decodeXtensa(bytes(xasm.beqz(3, 0x40, pc)), 0, pc)).toMatchObject({
      mnemonic: "beqz",
      s: 3,
      target: 0x40,
    });
    expect(decodeXtensa(bytes(xasm.bnez(3, 0xc0, pc)), 0, pc)).toMatchObject({
      mnemonic: "bnez",
      s: 3,
      target: 0xc0,
    });
    // Immediate compare resolves through B4CONST / B4CONSTU.
    expect(decodeXtensa(bytes(xasm.blti(3, 8, 0xa0, pc)), 0, pc)).toMatchObject({
      mnemonic: "blti",
      s: 3,
      imm: 8,
      target: 0xa0,
    });
    expect(decodeXtensa(bytes(xasm.bgeui(3, 65536, 0xa0, pc)), 0, pc)).toMatchObject({
      mnemonic: "bgeui",
      s: 3,
      imm: 65536,
      target: 0xa0,
    });
    // Register compare + bit test.
    expect(decodeXtensa(bytes(xasm.bne(3, 4, 0x90, pc)), 0, pc)).toMatchObject({
      mnemonic: "bne",
      s: 3,
      t: 4,
      target: 0x90,
    });
    expect(decodeXtensa(bytes(xasm.bbci(5, 20, 0x90, pc)), 0, pc)).toMatchObject({
      mnemonic: "bbci",
      s: 5,
      imm: 20,
      target: 0x90,
    });
  });
});
