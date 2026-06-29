/**
 * Power subsystem abstraction.
 *
 * The Flywheel runs from a LiFePO4 (LFP) cell topped up by a solar panel and,
 * optionally, USB. The interesting emulator behavior is the energy balance:
 * instantaneous draw depends on the ESP power mode (active / light-sleep /
 * deep-sleep) and which components are powered (Wi-Fi being the dominant
 * consumer), while income depends on sun exposure and USB. Integrating that
 * balance over time drives the battery level the BIOS reports.
 *
 * Phase 0 ships a deliberately simple-but-plausible model behind this
 * interface; Phase 1/2 refine the numbers and add the light-sleep optimization
 * without changing the contract.
 */

import type { Emitter } from "../util/emitter.js";

/** ESP32-S3 high-level power mode. */
export const EspMode = {
  Active: "active",
  LightSleep: "light-sleep",
  DeepSleep: "deep-sleep",
} as const;
export type EspMode = (typeof EspMode)[keyof typeof EspMode];

/** Independently switchable consumers layered on top of the base ESP draw. */
export const PowerConsumer = {
  Wifi: "wifi",
  Display: "display",
  Audio: "audio",
} as const;
export type PowerConsumer = (typeof PowerConsumer)[keyof typeof PowerConsumer];

export type ConsumerStates = Readonly<Record<PowerConsumer, boolean>>;

/** Immutable view of the power system at one instant. */
export interface PowerSnapshot {
  /** Battery state of charge, 0..1. */
  readonly level: number;
  /** Stored charge in mAh. */
  readonly chargeMah: number;
  /** Total usable capacity in mAh. */
  readonly capacityMah: number;
  /** Approximate terminal voltage (V). */
  readonly voltage: number;

  readonly espMode: EspMode;
  readonly consumers: ConsumerStates;

  /** Estimated instantaneous consumption (mA). */
  readonly drawMa: number;
  /** Solar income at the current sun exposure (mA). */
  readonly solarMa: number;
  /** USB income when connected (mA). */
  readonly usbMa: number;
  /** Net current into the battery; negative means discharging (mA). */
  readonly netMa: number;

  /** Sun exposure driving the panel, 0..1. */
  readonly sunExposure: number;
  readonly usbConnected: boolean;
  /** netMa > 0 (battery gaining charge). */
  readonly charging: boolean;
}

export interface PowerModelEvents {
  /** Fired whenever the power state changes (draw, income, level, mode…). */
  change: PowerSnapshot;
}

export interface PowerModel {
  /** Live change notifications for observers (UI, dev tools). */
  readonly events: Emitter<PowerModelEvents>;

  getSnapshot(): PowerSnapshot;

  /** Set the high-level ESP power mode. */
  setEspMode(mode: EspMode): void;
  /** Toggle an individual consumer. */
  setConsumer(consumer: PowerConsumer, on: boolean): void;

  /** Sun exposure 0..1 (clamped). */
  setSunExposure(exposure: number): void;
  setUsbConnected(connected: boolean): void;

  /** Directly set state of charge 0..1 (used by boot / dev tools). */
  setLevel(level: number): void;

  /**
   * Advance the energy balance by dtMs milliseconds.
   *
   * Integration is piecewise-constant: the whole interval is charged at the
   * (mode, consumers) profile active when tick() is called. To keep the energy
   * accounting accurate across a state change, callers should tick() up to the
   * moment of the change BEFORE calling setEspMode/setConsumer — otherwise the
   * new profile retroactively reprices the elapsed interval. This matters once
   * Phase 2 modulates light-sleep at sub-frame granularity.
   */
  tick(dtMs: number): void;
}
