import type { AudioDevice } from "./audio.js";
import type { DisplayDevice } from "./display.js";
import type { GamepadDevice } from "./gamepad.js";
import type { PowerModel } from "./power.js";
import type { SDCard } from "./sd.js";

/**
 * The complete hardware abstraction layer the rest of the system runs against.
 *
 * This is THE boundary the whole design depends on: the BIOS and Lua call
 * these subsystems, and the emulator supplies a JS implementation. Much later,
 * instruction-level execution slots in behind this same interface — code that
 * runs against `FlywheelDevice` does not know or care whether the display is a
 * canvas or a real panel driven by emulated Xtensa.
 */
export interface FlywheelDevice {
  readonly display: DisplayDevice;
  readonly gamepad: GamepadDevice;
  readonly power: PowerModel;
  readonly sd: SDCard;
  readonly audio: AudioDevice;

  /**
   * Is the physical power switch on? This is the raw switch state only.
   * Boot/active/light-sleep substates are carried by `power` (see EspMode);
   * Phase 2's BIOS owns those transitions rather than powerOn() hardcoding them.
   */
  readonly poweredOn: boolean;

  /** Flip the physical power switch. */
  powerOn(): void;
  powerOff(): void;

  /**
   * Advance emulated time by dtMs. Drives the power energy balance and any
   * time-based subsystem behavior. The host run loop calls this each frame.
   */
  tick(dtMs: number): void;
}
