// Execution backends: the shared frame-driven runtime contract + the wasm32
// native-module backend.
export type {
  ModuleRuntime,
  ModuleRuntimeCallbacks,
  RuntimeStatus,
} from "./module-runtime.js";
export { WasmModuleRuntime } from "./wasm-runtime.js";
export { XtensaModuleRuntime } from "./xtensa/xtensa-runtime.js";
export { XtensaCpu } from "./xtensa/xtensa-cpu.js";
export { decodeXtensa, type XtensaInsn } from "./xtensa/xtensa-decode.js";
export { createWasmEnv, type WasmEnvContext } from "./wasm-imports.js";
export {
  HAL_OPS,
  HAL_OP_NAMES,
  callHalOp,
  type HalContext,
  type HalOpName,
} from "./hal-ops.js";
export { type MemAccess, WasmMem, ArenaMem } from "./mem-access.js";
export { readCString, readBytes, writeBytes } from "./wasm-memory.js";
