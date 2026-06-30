// Faithfulness harness: record a module's HAL effect trace and replay scripted
// input deterministically, so behavior is reproducible and comparable across
// execution backends (wasm32 now; Xtensa interpreter later, differentially).
export {
  HalEffectRecorder,
  RecordingAudioDevice,
  type HalEvent,
} from "./effect-trace.js";
export {
  runConformance,
  type ConformanceResult,
  type InputFrame,
  type InputScript,
} from "./conformance.js";
