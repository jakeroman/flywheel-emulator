// @flywheel/emulator-core — the framework-agnostic emulation core.

// Hardware abstraction layer (contracts).
export * from "./hal/index.js";

// Concrete emulated implementations.
// (GamepadEvents / PowerModelEvents / SDEvents are part of the HAL contracts
// above, re-exported via ./hal/index.js.)
export { FrameBuffer } from "./device/frame-buffer.js";
export { Gamepad } from "./device/gamepad.js";
export { EmulatedPowerModel, POWER_CONSTANTS } from "./device/power-model.js";
export { MemorySDCard, seedMockContent } from "./device/memory-sd.js";
export {
  EmulatedFlywheelDevice,
  createDevice,
  type DeviceEvents,
  type DeviceOptions,
} from "./device/flywheel-device.js";

// Utilities.
export { Emitter, type Listener } from "./util/emitter.js";
