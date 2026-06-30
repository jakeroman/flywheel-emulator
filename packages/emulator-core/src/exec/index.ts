// Execution backends: the shared frame-driven runtime contract + the wasm32
// native-module backend.
export type {
  ModuleRuntime,
  ModuleRuntimeCallbacks,
  RuntimeStatus,
} from "./module-runtime.js";
export { WasmModuleRuntime } from "./wasm-runtime.js";
export { createWasmEnv, type WasmEnvContext } from "./wasm-imports.js";
export { readCString, readBytes, writeBytes } from "./wasm-memory.js";
