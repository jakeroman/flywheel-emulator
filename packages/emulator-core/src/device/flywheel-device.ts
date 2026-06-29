import { Emitter } from "../util/emitter.js";
import { EspMode } from "../hal/power.js";
import type { FlywheelDevice } from "../hal/device.js";
import { NullAudioDevice, type AudioDevice } from "../hal/audio.js";
import { FrameBuffer } from "./frame-buffer.js";
import { Gamepad } from "./gamepad.js";
import { EmulatedPowerModel } from "./power-model.js";
import { MemorySDCard, seedMockContent } from "./memory-sd.js";

export interface DeviceEvents {
  power: { poweredOn: boolean };
}

export interface DeviceOptions {
  initialBatteryLevel?: number;
  audio?: AudioDevice;
}

/**
 * The emulated Flywheel. Owns concrete implementations of every subsystem and
 * the power-switch lifecycle. The web UI renders from these subsystems and
 * drives input into them; the BIOS (Phase 2) and Lua (Phase 1) run against the
 * FlywheelDevice interface without knowing they are emulated.
 */
export class EmulatedFlywheelDevice implements FlywheelDevice {
  readonly events = new Emitter<DeviceEvents>();

  readonly display = new FrameBuffer();
  readonly gamepad = new Gamepad();
  readonly power: EmulatedPowerModel;
  readonly sd = new MemorySDCard();
  readonly audio: AudioDevice;

  private _poweredOn = false;

  constructor(options: DeviceOptions = {}) {
    this.power = new EmulatedPowerModel(options.initialBatteryLevel ?? 0.75);
    this.audio = options.audio ?? new NullAudioDevice();
    // Off until the switch is flipped: the ESP idles in deep sleep, though the
    // solar panel can still trickle-charge the battery.
    this.power.setEspMode(EspMode.DeepSleep);
  }

  get poweredOn(): boolean {
    return this._poweredOn;
  }

  powerOn(): void {
    if (this._poweredOn) return;
    this._poweredOn = true;
    // Phase 2: the BIOS owns mode transitions (boot → active → light-sleep).
    // Until then we go straight to Active on power-up.
    this.power.setEspMode(EspMode.Active);
    this.events.emit("power", { poweredOn: true });
  }

  powerOff(): void {
    if (!this._poweredOn) return;
    this._poweredOn = false;
    this.gamepad.releaseAll();
    this.audio.stop();
    this.power.setEspMode(EspMode.DeepSleep);
    this.events.emit("power", { poweredOn: false });
  }

  tick(dtMs: number): void {
    // The energy balance always advances — solar charges even when off.
    this.power.tick(dtMs);
  }
}

/** Create a fully wired emulated device, optionally seeded with mock content. */
export async function createDevice(
  options: DeviceOptions & { seed?: boolean } = {},
): Promise<EmulatedFlywheelDevice> {
  const device = new EmulatedFlywheelDevice(options);
  if (options.seed ?? true) {
    await seedMockContent(device.sd);
  }
  return device;
}
