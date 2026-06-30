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

// BEQZ.N (tBase 0x8) / BNEZ.N (tBase 0xc): the 6-bit offset is unsigned and
// forward-only (target = pc + 4 + off, off in 0..63). Backward narrow branches
// don't exist — use a full branch / J instead.
function narrowBranch(
  tBase: number,
  s: number,
  target: number,
  pc: number,
): number[] {
  const off = target - pc - 4;
  if (off < 0 || off > 63) {
    throw new Error(
      `beqz.n/bnez.n offset out of range (forward 0..63): ${off}`,
    );
  }
  return narrow(0xc, tBase | ((off >> 4) & 0x3), s, off & 0xf);
}

/** Branch byte offset = target - pc - 4, range-checked to a signed N-bit field. */
function branchOff(target: number, pc: number, bits: number): number {
  const off = target - pc - 4;
  const lim = 1 << (bits - 1);
  if (off < -lim || off >= lim) {
    throw new Error(`branch offset out of signed ${bits}-bit range: ${off}`);
  }
  return off;
}

// BRI12 zero-compare (op0=6, t = which<<2 | 1): 12-bit signed offset.
const bri12 = (which: number, s: number, target: number, pc: number) =>
  w24(0x6 | (((which << 2) | 1) << 4) | (s << 8) | ((branchOff(target, pc, 12) & 0xfff) << 12));

// BRI8 immediate (op0=6): t = which<<2 | n (n=2 signed, 3 unsigned); r = B4CONST
// index; 8-bit signed offset. `idx` is the caller's pre-resolved table index.
const bri8imm = (which: number, n: number, idx: number, s: number, target: number, pc: number) =>
  w24(0x6 | (((which << 2) | n) << 4) | (s << 8) | (idx << 12) | ((branchOff(target, pc, 8) & 0xff) << 16));

// BRI8 register/bit (op0=7): r selects the comparison; 8-bit signed offset.
const bri8reg = (rsel: number, t: number, s: number, target: number, pc: number) =>
  w24(0x7 | (t << 4) | (s << 8) | (rsel << 12) | ((branchOff(target, pc, 8) & 0xff) << 16));

const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
const b4idx = (table: number[], v: number, name: string): number => {
  const idx = table.indexOf(v);
  if (idx < 0) throw new Error(`${name}: ${v} is not a valid B4CONST immediate`);
  return idx;
};

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
  l16si: (t: number, s: number, off: number) => rri8(2, t, s, 0x9, off >> 1),

  // ---- shifts (dest=r) ----
  slli: (r: number, s: number, shift: number) => {
    if (shift < 1 || shift > 31) throw new Error(`slli shift 1..31: ${shift}`);
    const sa = 32 - shift; // 1..31
    return wide(0, sa & 0xf, s, r, 1, (sa >> 4) & 1);
  },
  srai: (r: number, t: number, sa: number) => {
    if (sa < 0 || sa > 31) throw new Error(`srai amount 0..31: ${sa}`);
    return wide(0, t, sa & 0xf, r, 1, 2 | ((sa >> 4) & 1));
  },
  srli: (r: number, t: number, sa: number) => {
    if (sa < 0 || sa > 15) throw new Error(`srli amount 0..15: ${sa}`);
    return wide(0, t, sa, r, 1, 4);
  },
  sll: (r: number, s: number) => wide(0, 0, s, r, 1, 0xa),
  srl: (r: number, t: number) => wide(0, t, 0, r, 1, 9),
  sra: (r: number, t: number) => wide(0, t, 0, r, 1, 0xb),
  ssl: (s: number) => wide(0, 0, s, 1, 0, 4),
  ssr: (s: number) => wide(0, 0, s, 0, 0, 4),

  // ---- bitfield ----
  extui: (r: number, t: number, shiftimm: number, nbits: number) => {
    if (shiftimm < 0 || shiftimm > 31) throw new Error(`extui shift 0..31: ${shiftimm}`);
    if (nbits < 1 || nbits > 16) throw new Error(`extui width 1..16: ${nbits}`);
    return wide(0, t, shiftimm & 0xf, r, 4 | ((shiftimm >> 4) & 1), nbits - 1);
  },
  sext: (r: number, s: number, bit: number) => wide(0, bit - 7, s, r, 3, 2),

  // ---- multiply / min / max / conditional move (op1=2 / op1=3) ----
  mull: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 8),
  muluh: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xa),
  mulsh: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xb),
  quou: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xc),
  quos: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xd),
  remu: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xe),
  rems: (r: number, s: number, t: number) => wide(0, t, s, r, 2, 0xf),
  min: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 4),
  max: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 5),
  minu: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 6),
  maxu: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 7),
  moveqz: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 8),
  movnez: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 9),
  movltz: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 0xa),
  movgez: (r: number, s: number, t: number) => wide(0, t, s, r, 3, 0xb),

  // ---- narrow (.n) ----
  l32iN: (t: number, s: number, off: number) => narrow(0x8, t, s, off >> 2),
  s32iN: (t: number, s: number, off: number) => narrow(0x9, t, s, off >> 2),
  addN: (r: number, s: number, t: number) => narrow(0xa, t, s, r),
  addiN: (r: number, s: number, imm: number) =>
    narrow(0xb, (imm === -1 ? 0 : imm) & 0xf, s, r),
  // MOV.N dest, src → AR[dest] = AR[src]; dest is the t-field, src the s-field.
  movN: (dest: number, src: number) => narrow(0xd, dest, src, 0),
  moviN: (s: number, imm: number) => {
    const i7 = imm & 0x7f;
    return narrow(0xc, (i7 >> 4) & 0x7, s, i7 & 0xf);
  },

  // ---- calls / returns / control ----
  callx0: (s: number) => w24(0x0000c0 | (s << 8)),
  jx: (s: number) => w24(0x0000a0 | (s << 8)), // JX a[s]
  ret: () => w24(0x000080), // RET → a0 (s=0)
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
    // Base is (pc+3)&~3 (see the decoder) — the inverse of its target math.
    const off = ((litTarget - ((((pc >>> 0) + 3) & ~3) >>> 0)) >> 2) & 0xffff;
    return w24(0x1 | (t << 4) | (off << 8));
  },
  beqzN: (s: number, target: number, pc: number) => narrowBranch(0x8, s, target, pc),
  bnezN: (s: number, target: number, pc: number) => narrowBranch(0xc, s, target, pc),

  // ---- branches: BRI12 zero-compare ----
  beqz: (s: number, target: number, pc: number) => bri12(0, s, target, pc),
  bnez: (s: number, target: number, pc: number) => bri12(1, s, target, pc),
  bltz: (s: number, target: number, pc: number) => bri12(2, s, target, pc),
  bgez: (s: number, target: number, pc: number) => bri12(3, s, target, pc),

  // ---- branches: BRI8 immediate-compare (B4CONST / B4CONSTU) ----
  beqi: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(0, 2, b4idx(B4CONST, imm, "beqi"), s, target, pc),
  bnei: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(1, 2, b4idx(B4CONST, imm, "bnei"), s, target, pc),
  blti: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(2, 2, b4idx(B4CONST, imm, "blti"), s, target, pc),
  bgei: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(3, 2, b4idx(B4CONST, imm, "bgei"), s, target, pc),
  bltui: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(2, 3, b4idx(B4CONSTU, imm, "bltui"), s, target, pc),
  bgeui: (s: number, imm: number, target: number, pc: number) =>
    bri8imm(3, 3, b4idx(B4CONSTU, imm, "bgeui"), s, target, pc),

  // ---- branches: BRI8 register-compare + bit-test ----
  beq: (s: number, t: number, target: number, pc: number) => bri8reg(0x1, t, s, target, pc),
  bne: (s: number, t: number, target: number, pc: number) => bri8reg(0x9, t, s, target, pc),
  blt: (s: number, t: number, target: number, pc: number) => bri8reg(0x2, t, s, target, pc),
  bge: (s: number, t: number, target: number, pc: number) => bri8reg(0xa, t, s, target, pc),
  bltu: (s: number, t: number, target: number, pc: number) => bri8reg(0x3, t, s, target, pc),
  bgeu: (s: number, t: number, target: number, pc: number) => bri8reg(0xb, t, s, target, pc),
  bany: (s: number, t: number, target: number, pc: number) => bri8reg(0x8, t, s, target, pc),
  bnone: (s: number, t: number, target: number, pc: number) => bri8reg(0x0, t, s, target, pc),
  ball: (s: number, t: number, target: number, pc: number) => bri8reg(0x4, t, s, target, pc),
  bnall: (s: number, t: number, target: number, pc: number) => bri8reg(0xc, t, s, target, pc),
  bbc: (s: number, t: number, target: number, pc: number) => bri8reg(0x5, t, s, target, pc),
  bbs: (s: number, t: number, target: number, pc: number) => bri8reg(0xd, t, s, target, pc),
  bbci: (s: number, bit: number, target: number, pc: number) =>
    bri8reg(0x6 | ((bit >> 4) & 1), bit & 0xf, s, target, pc),
  bbsi: (s: number, bit: number, target: number, pc: number) =>
    bri8reg(0xe | ((bit >> 4) & 1), bit & 0xf, s, target, pc),
};
