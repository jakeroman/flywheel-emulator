import { Emitter } from "../util/emitter.js";
import {
  EspMode,
  PowerConsumer,
  type ConsumerStates,
  type PowerModel,
  type PowerModelEvents,
  type PowerSnapshot,
} from "../hal/power.js";

/**
 * Tunable energy-balance constants. These are first-pass plausible figures for
 * an ESP32-S3 + Sharp memory display + small solar panel on an LFP cell; the
 * goal is believable behavior, not datasheet accuracy. Phase 1/2 can refine
 * them (and add the light-sleep optimization) in one place.
 */
export const POWER_CONSTANTS = {
  capacityMah: 1500,
  /** LFP terminal voltage at empty / full (very flat curve in reality). */
  voltageEmpty: 2.9,
  voltageFull: 3.4,

  /** Base draw by ESP mode (mA), before per-consumer additions. */
  baseDrawMa: {
    [EspMode.Active]: 38,
    [EspMode.LightSleep]: 2.2,
    [EspMode.DeepSleep]: 0.05,
  } satisfies Record<EspMode, number>,

  /** Additional draw per active consumer (mA). */
  consumerDrawMa: {
    [PowerConsumer.Wifi]: 120,
    [PowerConsumer.Display]: 0.5,
    [PowerConsumer.Audio]: 12,
  } satisfies Record<PowerConsumer, number>,

  /** Solar panel output at full exposure (mA). */
  solarMaxMa: 110,
  /** USB charge current when connected (mA). */
  usbChargeMa: 480,
} as const;

export class EmulatedPowerModel implements PowerModel {
  readonly events = new Emitter<PowerModelEvents>();

  private chargeMah: number;
  private espMode: EspMode = EspMode.Active;
  private consumers: Record<PowerConsumer, boolean> = {
    [PowerConsumer.Wifi]: false,
    [PowerConsumer.Display]: true,
    [PowerConsumer.Audio]: false,
  };
  private sunExposure = 0;
  private usbConnected = false;

  constructor(initialLevel = 0.75) {
    this.chargeMah = clamp01(initialLevel) * POWER_CONSTANTS.capacityMah;
  }

  getSnapshot(): PowerSnapshot {
    const drawMa = this.computeDrawMa();
    const solarMa = this.sunExposure * POWER_CONSTANTS.solarMaxMa;
    const usbMa = this.usbConnected ? POWER_CONSTANTS.usbChargeMa : 0;
    const netMa = solarMa + usbMa - drawMa;
    const level = this.chargeMah / POWER_CONSTANTS.capacityMah;
    return {
      level,
      chargeMah: this.chargeMah,
      capacityMah: POWER_CONSTANTS.capacityMah,
      voltage:
        POWER_CONSTANTS.voltageEmpty +
        level * (POWER_CONSTANTS.voltageFull - POWER_CONSTANTS.voltageEmpty),
      espMode: this.espMode,
      consumers: { ...this.consumers } as ConsumerStates,
      drawMa,
      solarMa,
      usbMa,
      netMa,
      sunExposure: this.sunExposure,
      usbConnected: this.usbConnected,
      charging: netMa > 0,
    };
  }

  setEspMode(mode: EspMode): void {
    if (this.espMode === mode) return;
    this.espMode = mode;
    this.emitChange();
  }

  setConsumer(consumer: PowerConsumer, on: boolean): void {
    if (this.consumers[consumer] === on) return;
    this.consumers[consumer] = on;
    this.emitChange();
  }

  setSunExposure(exposure: number): void {
    const next = clamp01(exposure);
    if (next === this.sunExposure) return;
    this.sunExposure = next;
    this.emitChange();
  }

  setUsbConnected(connected: boolean): void {
    if (this.usbConnected === connected) return;
    this.usbConnected = connected;
    this.emitChange();
  }

  setLevel(level: number): void {
    this.chargeMah = clamp01(level) * POWER_CONSTANTS.capacityMah;
    this.emitChange();
  }

  tick(dtMs: number): void {
    const snap = this.getSnapshot();
    // mAh delta = mA * hours.
    const deltaMah = (snap.netMa * dtMs) / 3_600_000;
    const next = clamp(
      this.chargeMah + deltaMah,
      0,
      POWER_CONSTANTS.capacityMah,
    );
    if (next !== this.chargeMah) {
      this.chargeMah = next;
      this.emitChange();
    }
  }

  private computeDrawMa(): number {
    let draw = POWER_CONSTANTS.baseDrawMa[this.espMode];
    // Deep sleep gates everything but the leakage floor.
    if (this.espMode === EspMode.DeepSleep) return draw;
    for (const consumer of Object.keys(this.consumers) as PowerConsumer[]) {
      if (this.consumers[consumer]) {
        draw += POWER_CONSTANTS.consumerDrawMa[consumer];
      }
    }
    return draw;
  }

  private emitChange(): void {
    this.events.emit("change", this.getSnapshot());
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
