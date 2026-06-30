import { describe, expect, it } from "vitest";
import { XtensaCpu } from "./xtensa-cpu.js";
import { program, xasm } from "./xtensa-asm.js";

const BASE = 0x3fc88000;
const HOST_RETURN = 0x90000000; // outside the arena → "stop"

/** Load a program at BASE, run to a ret-to-HOST_RETURN, return the CPU. */
function run(
  insns: number[][],
  setup?: (cpu: XtensaCpu) => void,
  onSentinel?: (cpu: XtensaCpu, addr: number) => void,
): XtensaCpu {
  const arena = new Uint8Array(0x10000);
  arena.set(program(...insns), 0);
  const cpu = new XtensaCpu(arena, BASE);
  cpu.pc = BASE;
  cpu.ar[0] = HOST_RETURN | 0; // return address
  cpu.ar[1] = BASE + 0x8000; // stack pointer, mid-arena
  setup?.(cpu);
  cpu.run((addr) => {
    if ((addr >>> 0) === (HOST_RETURN >>> 0)) return "stop";
    if (onSentinel) {
      onSentinel(cpu, addr >>> 0);
      cpu.pc = cpu.ar[0] >>> 0; // simulate the host-call return
      return "continue";
    }
    throw new Error(`unexpected jump to 0x${(addr >>> 0).toString(16)}`);
  });
  return cpu;
}

describe("XtensaCpu execution", () => {
  it("arithmetic + immediates", () => {
    const cpu = run([
      xasm.movi(2, 7),
      xasm.movi(3, 5),
      xasm.add(4, 2, 3), // a4 = 12
      xasm.sub(5, 2, 3), // a5 = 2
      xasm.addi(6, 4, -2), // a6 = 10
      xasm.ret(),
    ]);
    expect(cpu.ar[4]).toBe(12);
    expect(cpu.ar[5]).toBe(2);
    expect(cpu.ar[6]).toBe(10);
  });

  it("store then load round-trips through the arena (.n forms)", () => {
    const cpu = run(
      [
        xasm.movi(3, 1234 & 0x7ff), // a small value that fits movi
        xasm.s32iN(3, 2, 0), // mem[a2] = a3
        xasm.l32iN(4, 2, 0), // a4 = mem[a2]
        xasm.ret(),
      ],
      (c) => {
        c.ar[2] = BASE + 0x400; // a data address in the arena
      },
    );
    expect(cpu.ar[4]).toBe(1234 & 0x7ff);
    expect(cpu.load32(BASE + 0x400)).toBe(1234 & 0x7ff);
  });

  it("l32r loads a literal from the (backward) literal pool", () => {
    const arena = new Uint8Array(0x10000);
    // Literal at index 0 (word-aligned); program starts at index 0x10.
    new DataView(arena.buffer).setInt32(0, 0x1234abcd | 0, true);
    const prog = program(xasm.l32r(2, BASE + 0x0, BASE + 0x10), xasm.ret());
    arena.set(prog, 0x10);
    const cpu = new XtensaCpu(arena, BASE);
    cpu.pc = BASE + 0x10;
    cpu.ar[0] = HOST_RETURN | 0;
    cpu.run((a) => ((a >>> 0) === (HOST_RETURN >>> 0) ? "stop" : "continue"));
    expect(cpu.ar[2]).toBe(0x1234abcd | 0);
  });

  it("runs a counted loop (sum 5..1 = 15): forward beqz.n exit + backward j", () => {
    // a2 = 5 (counter), a3 = 0 (sum)
    // loop: if a2==0 goto done; a3 += a2; a2--; j loop;  done: ret
    // (beqz.n is forward-only; the backward edge uses the signed J.)
    const head = xasm.movi(2, 5).length + xasm.movi(3, 0).length; // 6
    const loopAt = BASE + head;
    const jAt = loopAt + 2 /*beqz.n*/ + 2 /*add.n*/ + 2; /*addi.n*/
    const doneAt = jAt + 3; /*j*/
    const cpu = run([
      xasm.movi(2, 5),
      xasm.movi(3, 0),
      xasm.beqzN(2, doneAt, loopAt),
      xasm.addN(3, 3, 2),
      xasm.addiN(2, 2, -1),
      xasm.j(loopAt, jAt),
      xasm.ret(),
    ]);
    expect(cpu.ar[3]).toBe(15);
    expect(cpu.ar[2]).toBe(0);
  });

  it("traps a CALLX0 to a host sentinel, passes a2, and resumes", () => {
    const SENT = 0x40010000;
    let seenA2 = -1;
    const cpu = run(
      [
        xasm.movN(15, 0), // save return addr (a0) in callee-saved a15
        xasm.movi(2, 7), // arg in a2
        xasm.callx0(8), // call a8 (= sentinel); clobbers a0
        xasm.movN(0, 15), // restore return addr
        xasm.ret(),
      ],
      (c) => {
        c.ar[8] = SENT | 0;
      },
      (c, addr) => {
        expect(addr).toBe(SENT >>> 0);
        seenA2 = c.ar[2];
        c.ar[2] = 123; // host return value
      },
    );
    expect(seenA2).toBe(7);
    expect(cpu.ar[2]).toBe(123);
  });

  it("throws on an out-of-bounds memory access", () => {
    expect(() =>
      run(
        [xasm.l32i(3, 2, 0), xasm.ret()],
        (c) => {
          c.ar[2] = 0x10000000; // far outside the arena
        },
      ),
    ).toThrow(/out-of-bounds/);
  });
});

describe("XtensaCpu — extended instruction set", () => {
  it("immediate + variable shifts (slli/srli/srai, ssl/sll, ssr/srl)", () => {
    const cpu = run([
      xasm.movi(2, 1),
      xasm.slli(3, 2, 4), // a3 = 1 << 4 = 16
      xasm.srli(4, 3, 2), // a4 = 16 >>> 2 = 4
      xasm.movi(5, -1),
      xasm.srai(6, 5, 1), // a6 = -1 >> 1 = -1 (arithmetic)
      xasm.srli(7, 5, 15), // a7 = 0xffffffff >>> 15 = 131071 (logical, not sign-extended)
      xasm.movi(8, 3),
      xasm.ssl(8), // SAR for a left shift by 3
      xasm.sll(9, 3), // a9 = 16 << 3 = 128
      xasm.ssr(8), // SAR for a right shift by 3
      xasm.srl(10, 9), // a10 = 128 >>> 3 = 16
      xasm.ret(),
    ]);
    expect([cpu.ar[3], cpu.ar[4], cpu.ar[6], cpu.ar[7]]).toEqual([
      16, 4, -1, 131071,
    ]);
    expect([cpu.ar[9], cpu.ar[10]]).toEqual([128, 16]);
  });

  it("extui extracts a bit field; sext sign-extends from a bit", () => {
    const cpu = run([
      xasm.movi(2, -1), // 0xffffffff
      xasm.extui(3, 2, 4, 8), // (0xffffffff >>> 4) & 0xff = 0xff = 255
      xasm.movi(4, 0x80), // bit 7 set
      xasm.sext(5, 4, 7), // sign-extend from bit 7 → 0xffffff80 = -128
      xasm.ret(),
    ]);
    expect([cpu.ar[3], cpu.ar[5]]).toEqual([255, -128]);
  });

  it("mull/muluh/mulsh give the correct low and high 64-bit words", () => {
    const cpu = run([
      xasm.movi(2, 1),
      xasm.slli(2, 2, 16), // a2 = 65536
      xasm.movN(3, 2), // a3 = 65536
      xasm.mull(4, 2, 3), // low 32 of 65536*65536 = 0
      xasm.muluh(5, 2, 3), // high 32 (unsigned) = 1
      xasm.neg(6, 2), // a6 = -65536
      xasm.mulsh(7, 6, 2), // high 32 (signed) of -(2^32) = -1
      xasm.muluh(8, 6, 2), // high 32 (unsigned) of 0xffff0000*0x10000
      xasm.ret(),
    ]);
    expect([cpu.ar[4], cpu.ar[5], cpu.ar[7]]).toEqual([0, 1, -1]);
    expect(cpu.ar[8]).toBe(0xffff); // (0xffff0000 * 0x10000) >> 32
  });

  it("min/max/minu/maxu treat sign correctly", () => {
    const cpu = run([
      xasm.movi(2, 5),
      xasm.movi(3, -3),
      xasm.min(4, 2, 3), // signed → -3
      xasm.max(5, 2, 3), // signed → 5
      xasm.minu(6, 2, 3), // unsigned → 5 (−3 is large unsigned)
      xasm.maxu(7, 2, 3), // unsigned → −3
      xasm.ret(),
    ]);
    expect([cpu.ar[4], cpu.ar[5], cpu.ar[6], cpu.ar[7]]).toEqual([-3, 5, 5, -3]);
  });

  it("conditional moves fire only when the gate register matches", () => {
    const cpu = run([
      xasm.movi(2, 0), // gate = 0
      xasm.movi(3, 99), // source
      xasm.movi(4, 1),
      xasm.moveqz(4, 3, 2), // a2==0 → a4 = 99
      xasm.movi(5, 7),
      xasm.movnez(5, 3, 2), // a2==0 → NOT moved → a5 stays 7
      xasm.ret(),
    ]);
    expect([cpu.ar[4], cpu.ar[5]]).toEqual([99, 7]);
  });

  it("l16si sign-extends a 16-bit load; l16ui zero-extends", () => {
    const cpu = run(
      [
        xasm.movi(2, -1),
        xasm.s16i(2, 8, 0), // store 0xffff
        xasm.l16si(3, 8, 0), // → -1
        xasm.l16ui(4, 8, 0), // → 65535
        xasm.ret(),
      ],
      (c) => {
        c.ar[8] = BASE + 0x400;
      },
    );
    expect([cpu.ar[3], cpu.ar[4]]).toEqual([-1, 65535]);
  });

  it("runs a counted loop with a backward register branch (bnez)", () => {
    // a2=5 counter, a3=0 sum; loop body then `bnez a2, loop` (backward, signed).
    const head = xasm.movi(2, 5).length + xasm.movi(3, 0).length;
    const loopAt = BASE + head;
    const bnezAt = loopAt + 2 /*add.n*/ + 2; /*addi.n*/
    const cpu = run([
      xasm.movi(2, 5),
      xasm.movi(3, 0),
      xasm.addN(3, 3, 2), // loop: sum += counter
      xasm.addiN(2, 2, -1), // counter--
      xasm.bnez(2, loopAt, bnezAt), // backward branch while counter != 0
      xasm.ret(),
    ]);
    expect(cpu.ar[3]).toBe(15);
    expect(cpu.ar[2]).toBe(0);
  });

  it("immediate compare branch (beqi) taken on equality", () => {
    // Layout (all 3-byte): movi@+0, beqi@+3, movi(else)@+6, j@+9, movi(then)@+12,
    // ret@+15.  if (a2 == 5) a3 = 1 else a3 = 2
    const beqiAt = BASE + 3;
    const jAt = BASE + 9;
    const thenAt = BASE + 12;
    const retAt = BASE + 15;
    const cpu = run([
      xasm.movi(2, 5),
      xasm.beqi(2, 5, thenAt, beqiAt), // == 5 → jump to "then"
      xasm.movi(3, 2), // else: a3 = 2
      xasm.j(retAt, jAt), // skip "then"
      xasm.movi(3, 1), // then: a3 = 1
      xasm.ret(),
    ]);
    expect(cpu.ar[3]).toBe(1);
  });

  it("integer divide/remainder: signed trunc, unsigned, div-by-zero→0", () => {
    const cpu = run([
      xasm.movi(2, 17),
      xasm.movi(3, 5),
      xasm.quos(4, 2, 3), // 17 / 5 = 3
      xasm.rems(5, 2, 3), // 17 % 5 = 2
      xasm.movi(6, -17),
      xasm.quos(7, 6, 3), // -17 / 5 = -3 (truncate toward zero)
      xasm.rems(8, 6, 3), // -17 % 5 = -2
      xasm.movi(9, -1), // 0xffffffff
      xasm.movi(10, 2),
      xasm.quou(11, 9, 10), // 0xffffffff / 2 = 0x7fffffff
      xasm.remu(12, 9, 10), // 0xffffffff % 2 = 1
      xasm.movi(13, 0),
      xasm.quos(14, 2, 13), // divide by zero → 0 (defined, not NaN)
      xasm.ret(),
    ]);
    expect([cpu.ar[4], cpu.ar[5], cpu.ar[7], cpu.ar[8]]).toEqual([3, 2, -3, -2]);
    expect([cpu.ar[11], cpu.ar[12], cpu.ar[14]]).toEqual([0x7fffffff, 1, 0]);
  });

  it("jx jumps to a[s] (real gcc tail-call form)", () => {
    // jx a5 (a5 = address of `movi a2,99`) skips the intervening movi a2,1.
    const cpu = run(
      [
        xasm.jx(5), // BASE+0: jump to a5
        xasm.movi(2, 1), // BASE+3: skipped
        xasm.movi(2, 99), // BASE+6: jx lands here
        xasm.ret(),
      ],
      (c) => {
        c.ar[5] = BASE + 6;
      },
    );
    expect(cpu.ar[2]).toBe(99);
  });

  it("mov.n copies src→dest, not the reverse (asymmetric so inversion shows)", () => {
    const cpu = run([
      xasm.movi(8, 42),
      xasm.movi(2, 7),
      xasm.movN(2, 8), // a2 = a8 → a2 becomes 42, a8 unchanged
      xasm.ret(),
    ]);
    expect(cpu.ar[2]).toBe(42);
    expect(cpu.ar[8]).toBe(42); // source preserved (would be 7 if inverted)
  });

  it("srl/sra honor SAR=32 (shift-by-32) without JS shift-count wrap", () => {
    const srl = run([xasm.srl(3, 4), xasm.ret()], (c) => {
      c.ar[4] = 0x7fffffff;
      c.sar = 32; // as SSL would set for a 0-count left shift
    });
    expect(srl.ar[3]).toBe(0); // logical >> 32 → 0
    const sra = run([xasm.sra(3, 4), xasm.ret()], (c) => {
      c.ar[4] = -1;
      c.sar = 32;
    });
    expect(sra.ar[3]).toBe(-1); // arithmetic >> 32 of a negative → all ones
  });
});
