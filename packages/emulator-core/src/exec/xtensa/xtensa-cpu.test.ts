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

  it("runs a counted loop (sum 5..1 = 15) with add.n/addi.n/bnez.n", () => {
    // a2 = 5 (counter), a3 = 0 (sum); loop { a3+=a2; a2--; } while a2 != 0
    const movi5 = xasm.movi(2, 5); // 3 bytes @ +0
    const movi0 = xasm.movi(3, 0); // 3 bytes @ +3
    const loopAt = BASE + movi5.length + movi0.length; // +6
    const cpu = run([
      movi5,
      movi0,
      xasm.addN(3, 3, 2), // @loop
      xasm.addiN(2, 2, -1),
      xasm.bnezN(2, loopAt, loopAt + 2 + 2), // pc of bnez.n = loop + 4
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
