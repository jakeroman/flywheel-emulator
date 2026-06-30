import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../../device/flywheel-device.js";
import { Arch, FwModule } from "../../fwmod/index.js";
import {
  HalEffectRecorder,
  RecordingAudioDevice,
} from "../../harness/effect-trace.js";
import { runConformance, type InputScript } from "../../harness/conformance.js";
import { XtensaModuleRuntime } from "./xtensa-runtime.js";
import { xasm } from "./xtensa-asm.js";

/**
 * Hand-assemble a real call0 module (the layout a gcc -mabi=call0 module would
 * have): a literal pool + an FW global + the fw_module_t table, then code for
 * fw_main/init/update/draw. draw calls fw_api->pixel(x,y,on) through the jump
 * table. This is the Xtensa analog of examples/hello-wasm.wat — it pins the
 * call0 module ABI the XtensaModuleRuntime executes.
 */
function buildPixelModule(
  base: number,
  px: number,
  py: number,
): { payload: Uint8Array; entryOffset: number } {
  const LIT0 = 0x00; // word: address of the FW global
  const LIT1 = 0x04; // word: address of the fw_module_t table
  const FW = 0x08; // the stored api pointer
  const MODULE = 0x0c; // fw_module_t { init, update, draw } (filled below)
  const CODE = 0x20; // literals are backward of the code (l32r requirement)
  const PIXEL_OFF = 12 + 3 * 4; // fw_api_t slot 3 (pixel)

  const buf = new Uint8Array(256);
  const dv = new DataView(buf.buffer);
  let off = CODE;
  const at = () => base + off;
  const emit = (insn: number[]): void => {
    buf.set(insn, off);
    off += insn.length;
  };

  // fw_main(api in a2): FW = api; return &MODULE in a2.
  const mainOff = off;
  emit(xasm.l32r(8, base + LIT0, at())); // a8 = &FW
  emit(xasm.s32iN(2, 8, 0)); // *a8 = a2
  emit(xasm.l32r(2, base + LIT1, at())); // a2 = &MODULE
  emit(xasm.retN());

  const initOff = off;
  emit(xasm.retN()); // init: no-op

  const updateOff = off;
  emit(xasm.retN()); // update: no-op (ignores dt)

  // draw(): FW->pixel(px, py, 1). Saves/restores a0 around the host call.
  const drawOff = off;
  emit(xasm.addi(1, 1, -16)); // frame
  emit(xasm.s32iN(0, 1, 0)); // save return addr
  emit(xasm.l32r(8, base + LIT0, at())); // a8 = &FW
  emit(xasm.l32iN(8, 8, 0)); // a8 = FW (the api ptr)
  emit(xasm.l32iN(9, 8, PIXEL_OFF)); // a9 = api->pixel (a sentinel)
  emit(xasm.movi(2, px));
  emit(xasm.movi(3, py));
  emit(xasm.movi(4, 1)); // on
  emit(xasm.callx0(9)); // FW->pixel(px,py,1)
  emit(xasm.l32iN(0, 1, 0)); // restore return addr
  emit(xasm.addi(1, 1, 16));
  emit(xasm.retN());

  dv.setUint32(LIT0, (base + FW) >>> 0, true);
  dv.setUint32(LIT1, (base + MODULE) >>> 0, true);
  dv.setUint32(MODULE + 0, (base + initOff) >>> 0, true);
  dv.setUint32(MODULE + 4, (base + updateOff) >>> 0, true);
  dv.setUint32(MODULE + 8, (base + drawOff) >>> 0, true);

  return { payload: buf.slice(0, off), entryOffset: mainOff };
}

const nullAudio = {
  enabled: false,
  setEnabled() {},
  playTone() {},
  playSamples() {},
  stop() {},
};

const BASE = 0x3fc88000;
const SCRIPT: InputScript = { frames: [{}, {}, {}] };

describe("XtensaModuleRuntime (call0 backend, end-to-end)", () => {
  it("runs a hand-assembled call0 module that draws a pixel via fw_api", async () => {
    const { payload, entryOffset } = buildPixelModule(BASE, 10, 20);
    const fwmod = new FwModule({
      payload,
      arch: Arch.XtensaLx7,
      entryOffset,
      loadAddr: BASE,
    }).encode();

    const recorder = new HalEffectRecorder();
    const device = new EmulatedFlywheelDevice({
      audio: new RecordingAudioDevice(recorder.push, nullAudio),
    });
    const runtime = new XtensaModuleRuntime(device, {
      onLog: (m) => recorder.log(m),
    });

    const ok = await runtime.load(fwmod);
    expect(ok).toBe(true);
    expect(runtime.status).toBe("running");

    const { framesRun } = runConformance(device, runtime, SCRIPT, recorder);
    expect(framesRun).toBe(SCRIPT.frames.length);
    // The C/call0 module drove fw_api->pixel(10,20,1) through the interpreter.
    expect(device.display.getPixel(10, 20)).toBe(true);
    expect(device.display.getPixel(11, 20)).toBe(false);

    runtime.dispose();
  });

  it("is deterministic and fails cleanly on the wrong arch", async () => {
    const run = async () => {
      const { payload, entryOffset } = buildPixelModule(BASE, 30, 40);
      const fwmod = new FwModule({
        payload,
        arch: Arch.XtensaLx7,
        entryOffset,
        loadAddr: BASE,
      }).encode();
      const device = new EmulatedFlywheelDevice();
      const runtime = new XtensaModuleRuntime(device);
      await runtime.load(fwmod);
      runConformance(device, runtime, SCRIPT, new HalEffectRecorder());
      const crc = (() => {
        const buf = device.display.getPackedBuffer();
        let c = 0;
        for (let i = 0; i < buf.length; i++) c = (c + buf[i] * (i + 1)) >>> 0;
        return c;
      })();
      runtime.dispose();
      return crc;
    };
    expect(await run()).toBe(await run());

    // A wasm32 fixture is the wrong arch for this backend.
    const wrong = new FwModule({
      payload: new Uint8Array([1, 2, 3, 4]),
      arch: Arch.Wasm32,
    }).encode();
    const device = new EmulatedFlywheelDevice();
    const errs: string[] = [];
    const rt = new XtensaModuleRuntime(device, { onError: (e) => errs.push(e.message) });
    expect(await rt.load(wrong)).toBe(false);
    expect(rt.status).toBe("error");
    expect(errs[0]).toMatch(/arch/);
  });
});
