import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import {
  HalEffectRecorder,
  RecordingAudioDevice,
} from "../harness/effect-trace.js";
import { runConformance, type InputScript } from "../harness/conformance.js";
import type { ModuleRuntime, ModuleRuntimeCallbacks } from "./module-runtime.js";
import { WasmModuleRuntime } from "./wasm-runtime.js";
import { XtensaModuleRuntime } from "./xtensa/xtensa-runtime.js";

/**
 * The Phase-5 "for real" proof: ONE C source (examples/hello.c) compiled by TWO
 * real toolchains into two .fwmod modules —
 *   - hello-clang-wasm32.fwmod  (clang --target=wasm32)
 *   - hello-gcc-xtensa.fwmod    (xtensa-esp-elf-gcc -Os -mabi=call0, ESP32-S3 LE)
 * — driven through their respective backends (WebAssembly vs. the hand-rolled
 * Xtensa LX7 interpreter) with the SAME scripted input must yield BYTE-IDENTICAL
 * HAL effect traces. That equality is the differential oracle: if the
 * interpreter mis-executes any real gcc instruction (e.g. the `rems` behind
 * `ticks % span`), the swept dot lands on a different pixel and a frame CRC
 * diverges. Regenerate the fixtures with:
 *   python -m fwmod build examples/hello.c --arch wasm32 --cc <clang> -o fixtures/hello-clang-wasm32.fwmod
 *   python -m fwmod build examples/hello.c --arch xtensa-lx7 --prefix xtensa-esp-elf- \
 *     --toolchain-dir <esp bin> --dynconfig xtensa_esp32s3.so -o fixtures/hello-gcc-xtensa.fwmod
 */
const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(path.resolve(dirname, "../../../../tools/fwmod/fixtures", name)),
  );

// Enough frames to advance `ticks` past a few dot positions, with one A press
// (tone + log) and its release. Identical for both backends.
const SCRIPT: InputScript = {
  frames: [{}, {}, { press: ["A"] }, { release: ["A"] }, {}, {}, {}, {}],
};

type Backend = new (
  device: EmulatedFlywheelDevice,
  callbacks?: ModuleRuntimeCallbacks,
) => ModuleRuntime & { load(bytes: Uint8Array): Promise<boolean> };

async function run(Runtime: Backend, fixtureName: string) {
  const recorder = new HalEffectRecorder();
  const device = new EmulatedFlywheelDevice({
    audio: new RecordingAudioDevice(recorder.push, {
      enabled: false,
      setEnabled() {},
      playTone() {},
      playSamples() {},
      stop() {},
    }),
  });
  recorder.attachSd(device.sd);
  const runtime = new Runtime(device, { onLog: (m) => recorder.log(m) });
  const ok = await runtime.load(fixture(fixtureName));
  const result = runConformance(device, runtime, SCRIPT, recorder);
  runtime.dispose();
  return { ok, ...result };
}

describe("differential: real clang-wasm32 vs. real gcc-xtensa (same hello.c)", () => {
  it("the Xtensa interpreter runs real gcc -Os call0 output end-to-end", async () => {
    const x = await run(XtensaModuleRuntime, "hello-gcc-xtensa.fwmod");
    expect(x.ok).toBe(true);
    expect(x.finalStatus).toBe("running");
    expect(x.framesRun).toBe(SCRIPT.frames.length);
    // fw_main ran (module loaded) and draw() produced frame snapshots.
    expect(x.events.filter((e) => e.kind === "frame")).toHaveLength(
      SCRIPT.frames.length,
    );
  });

  it("both backends emit the A-press tone(440,120) and 'beep' log", async () => {
    const w = await run(WasmModuleRuntime, "hello-clang-wasm32.fwmod");
    const x = await run(XtensaModuleRuntime, "hello-gcc-xtensa.fwmod");
    for (const r of [w, x]) {
      expect(r.events).toContainEqual({ kind: "tone", hz: 440, ms: 120 });
      expect(r.events).toContainEqual({ kind: "log", message: "beep" });
    }
  });

  it("produces byte-identical HAL effect traces across both backends", async () => {
    const w = await run(WasmModuleRuntime, "hello-clang-wasm32.fwmod");
    const x = await run(XtensaModuleRuntime, "hello-gcc-xtensa.fwmod");
    expect(x.ok && w.ok).toBe(true);
    // Same frame CRCs, tones, logs, in the same order — the differential oracle.
    expect(x.events).toEqual(w.events);
  });

  it("the swept dot actually moves (frames are not all identical)", async () => {
    const x = await run(XtensaModuleRuntime, "hello-gcc-xtensa.fwmod");
    const frames = x.events.filter(
      (e): e is { kind: "frame"; crc32: number } => e.kind === "frame",
    );
    expect(new Set(frames.map((f) => f.crc32)).size).toBeGreaterThan(1);
  });
});
