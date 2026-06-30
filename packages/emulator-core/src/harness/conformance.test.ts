import { describe, expect, it } from "vitest";
import { EmulatedFlywheelDevice } from "../device/flywheel-device.js";
import { LuaRuntime } from "../lua/lua-runtime.js";
import { HalEffectRecorder, RecordingAudioDevice } from "./effect-trace.js";
import { runConformance, type InputScript } from "./conformance.js";

// A small Lua app that exercises display, audio, fs, and log so the recorded
// trace covers every HalEvent kind. (The wasm32 backend will run the SAME
// harness against an equivalent C module once LLVM is available.)
const APP = `
function _init() fw.log("init") end
function _update(dt)
  if fw.btnp(fw.A) then fw.sound.tone(440, 100) end
  if fw.btnp(fw.B) then fw.fs.write("/note.txt", "hi") end
end
function _draw()
  fw.gfx.cls()
  fw.gfx.rect(2, 2, 20, 20)
  if fw.btn(fw.A) then fw.gfx.rectfill(40, 40, 8, 8) end
end
`;

const SCRIPT: InputScript = {
  frames: [
    {}, // idle
    { press: ["A"] }, // tone + rectfill
    { release: ["A"] }, // back to just the rect
    { press: ["B"] }, // fs write
    { release: ["B"] },
  ],
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
  const runtime = new LuaRuntime(device, { onLog: (m) => recorder.log(m) });
  await runtime.load(APP);
  const result = runConformance(device, runtime, SCRIPT, recorder);
  await runtime.dispose();
  return result;
}

describe("conformance harness", () => {
  it("records a complete, well-ordered HAL effect trace", async () => {
    const { events, finalStatus, framesRun } = await run();
    expect(finalStatus).toBe("running");
    expect(framesRun).toBe(SCRIPT.frames.length);

    // One frame snapshot per driven frame.
    expect(events.filter((e) => e.kind === "frame")).toHaveLength(framesRun);
    // _init ran before any frame and logged.
    expect(events[0]).toEqual({ kind: "log", message: "init" });
    // A-press produced a tone; B-press produced an SD write.
    expect(events).toContainEqual({ kind: "tone", hz: 440, ms: 100 });
    expect(events).toContainEqual({ kind: "fsChange", path: "/note.txt" });
  });

  it("is deterministic: identical script + module → identical trace", async () => {
    const a = await run();
    const b = await run();
    expect(b.events).toEqual(a.events);
  });

  it("the A-held frame differs from the idle frame (input affects output)", async () => {
    const { events } = await run();
    const frames = events.filter(
      (e): e is { kind: "frame"; crc32: number } => e.kind === "frame",
    );
    // frame[0] is idle (rect only); frame[1] has the extra rectfill (A held).
    expect(frames[1].crc32).not.toBe(frames[0].crc32);
  });
});
