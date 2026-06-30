/**
 * A tiny Xtensa assembler — the inverse of xtensa-decode.ts.
 *
 * It lets unit tests and (later) a conformance module be authored as readable
 * instruction calls instead of hand-encoded hex, and the assemble→decode
 * round-trip is a free self-consistency check on both halves. Each encoder is
 * anchored to the same authoritative sources as the decoder and to real gcc
 * bytes (e.g. `add a3,a2,a1` = 10 32 80, `movi.n a8,-7` = 7c 98).
 *
 * Each function returns the instruction's bytes (little-endian). PC-relative
 * ops take the target + the instruction's own guest PC and compute the offset
 * (the exact inverse of the decoder's target math).
 */

const w24 = (word: number): number[] => [
  word & 0xff,
  (word >> 8) & 0xff,
  (word >> 16) & 0xff,
];
const w16 = (word: number): number[] => [word & 0xff, (word >> 8) & 0xff];

const wide = (op0: number, t: number, s: number, r: number, op1: number, op2: number) =>
  w24(op0 | (t << 4) | (s << 8) | (r << 12) | (op1 << 16) | (op2 << 20));
const rri8 = (op0: number, t: number, s: number, r: number, imm8: number) =>
  w24(op0 | (t << 4) | (s << 8) | (r << 12) | ((imm8 & 0xff) << 16));
const narrow = (op0: number, t: number, s: number, r: number) =>
  w16(op0 | (t << 4) | (s << 8) | (r << 12));

/** Concatenate instruction byte-arrays into a program buffer. */
export function program(...insns: number[][]): Uint8Array {
  return Uint8Array.from(insns.flat());
}

export const xasm = {
  // ---- RRR arithmetic/logical (dest = r) ----
  add: (r: number, s: number, t: number) => wide(0, t, s, r, 0, 0x8),
  sub: (r: number, s: number, t: number) => wide(0, t, s, r, 0, 0xc),
  and: (r: number, s: number, t: number) => wide(0, t, s, r, 0, 0x1),
  or: (r: number, s: number, t: number) => wide(0, t, s, r, 0, 0x2),
  xor: (r: number, s: number, t: number) => wide(0, t, s, r, 0, 0x3),
  neg: (r: number, t: number) => wide(0, t, 0, r, 0, 0x6),
  abs: (r: number, t: number) => wide(0, t, 1, r, 0, 0x6),

  // ---- RRI8 immediate / load / store ----
  addi: (t: number, s: number, imm: number) => rri8(2, t, s, 0xc, imm),
  addmi: (t: number, s: number, imm: number) => rri8(2, t, s, 0xd, imm >> 8),
  movi: (t: number, imm: number) => rri8(2, t, (imm >> 8) & 0xf, 0xa, imm),
  l8ui: (t: number, s: number, off: number) => rri8(2, t, s, 0x0, off),
  l16ui: (t: number, s: number, off: number) => rri8(2, t, s, 0x1, off >> 1),
  l32i: (t: number, s: number, off: number) => rri8(2, t, s, 0x2, off >> 2),
  s8i: (t: number, s: number, off: number) => rri8(2, t, s, 0x4, off),
  s16i: (t: number, s: number, off: number) => rri8(2, t, s, 0x5, off >> 1),
  s32i: (t: number, s: number, off: number) => rri8(2, t, s, 0x6, off >> 2),

  // ---- narrow (.n) ----
  l32iN: (t: number, s: number, off: number) => narrow(0x8, t, s, off >> 2),
  s32iN: (t: number, s: number, off: number) => narrow(0x9, t, s, off >> 2),
  addN: (r: number, s: number, t: number) => narrow(0xa, t, s, r),
  addiN: (r: number, s: number, imm: number) =>
    narrow(0xb, (imm === -1 ? 0 : imm) & 0xf, s, r),
  movN: (s: number, t: number) => narrow(0xd, t, s, 0),
  moviN: (s: number, imm: number) => {
    const i7 = imm & 0x7f;
    return narrow(0xc, (i7 >> 4) & 0x7, s, i7 & 0xf);
  },

  // ---- calls / returns / control ----
  callx0: (s: number) => w24(0x0000c0 | (s << 8)),
  ret: () => w24(0x000080), // jx a0
  retN: () => w16(0xf00d),
  nop: () => w24(0x0020f0),
  nopN: () => w16(0xf03d),
  memw: () => w24(0x0020c0),

  // ---- PC-relative (inverse of the decoder's target math) ----
  call0: (target: number, pc: number) => {
    const off = (((target - ((pc & ~3) >>> 0) - 4) >> 2) & 0x3ffff) >>> 0;
    return w24(0x5 | (off << 6));
  },
  j: (target: number, pc: number) => {
    const off = (target - pc - 4) & 0x3ffff;
    return w24(0x6 | (off << 6));
  },
  l32r: (t: number, litTarget: number, pc: number) => {
    const off = ((litTarget - ((pc + 3) & ~3)) >> 2) & 0xffff;
    return w24(0x1 | (t << 4) | (off << 8));
  },
  beqzN: (s: number, target: number, pc: number) => {
    const off = (target - pc - 4) & 0x3f;
    return narrow(0xc, 0x8 | ((off >> 4) & 0x3), s, off & 0xf);
  },
  bnezN: (s: number, target: number, pc: number) => {
    const off = (target - pc - 4) & 0x3f;
    return narrow(0xc, 0xc | ((off >> 4) & 0x3), s, off & 0xf);
  },
};
