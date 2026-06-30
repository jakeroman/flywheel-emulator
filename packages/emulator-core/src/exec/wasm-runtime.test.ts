import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { loadFwmod } from "../fwmod/loader.js";
import {
  HalEffectRecorder,
  RecordingAudioDevice,
} from "../harness/effect-trace.js";
import { runConformance, type InputScript } from "../harness/conformance.js";
import { WasmModuleRuntime } from "./wasm-runtime.js";

// A frozen wasm32 .fwmod compiled from examples/hello-wasm.wat by the Python
// CLI (CI reads it; regenerate with: node tools/fwmod/fixtures/make_wasm_fixture.mjs).
const dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  dirname,
  "../../../../tools/fwmod/fixtures/hello-wasm32.fwmod",
);
const fwmodBytes = (): Uint8Array => new Uint8Array(readFileSync(FIXTURE));

const SCRIPT: InputScript = {
  frames: [{}, { press: ["A"] }, { release: ["A"] }],
};

async function run() {
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
  const runtime = new WasmModuleRuntime(device, { onLog: (m) => recorder.log(m) });
  const ok = await runtime.load(fwmodBytes());
  const result = runConformance(device, runtime, SCRIPT, recorder);
  runtime.dispose();
  return { ok, device, ...result };
}

describe("WasmModuleRuntime (wasm32 backend, first increment end-to-end)", () => {
  it("reports the fixture as runnable through the loader", () => {
    const r = loadFwmod(fwmodBytes());
    expect(r.loadable).toBe(true);
    expect(r.runnable).toBe(true); // wasm32 now has an execution backend
    expect(r.info?.archLabel).toBe("wasm32");
  });

  it("instantiates the module and drives it through the HAL", async () => {
    const { ok, device, finalStatus, framesRun, events } = await run();
    expect(ok).toBe(true);
    expect(finalStatus).toBe("running");
    expect(framesRun).toBe(SCRIPT.frames.length);

    // fw_main → init() logged before any frame.
    expect(events[0]).toEqual({ kind: "log", message: "init" });
    // draw() drew the rect outline (corner pixel set).
    expect(device.display.getPixel(2, 2)).toBe(true);
    // update() saw the A press and emitted a tone.
    expect(events).toContainEqual({ kind: "tone", hz: 440, ms: 100 });
    expect(events.filter((e) => e.kind === "frame")).toHaveLength(framesRun);
  });

  it("is deterministic: identical fixture + script → identical trace", async () => {
    const a = await run();
    const b = await run();
    expect(b.events).toEqual(a.events);
  });

  it("fails cleanly (status 'error') on a non-wasm .fwmod", async () => {
    // A host-x86 fixture is a valid .fwmod but the wrong arch for this backend.
    const hostFixture = path.resolve(
      dirname,
      "../../../../tools/fwmod/fixtures/hello-host-x86.fwmod",
    );
    const device = new EmulatedFlywheelDevice();
    const errors: string[] = [];
    const runtime = new WasmModuleRuntime(device, {
      onError: (e) => errors.push(e.message),
    });
    const ok = await runtime.load(new Uint8Array(readFileSync(hostFixture)));
    expect(ok).toBe(false);
    expect(runtime.status).toBe("error");
    expect(errors[0]).toMatch(/arch/);
  });
});
