import { describe, expect, it } from "vitest";
import { EspMode, PowerConsumer } from "../hal/power.js";
import { EmulatedPowerModel, POWER_CONSTANTS } from "./power-model.js";

const ONE_HOUR_MS = 3_600_000;

describe("EmulatedPowerModel", () => {
  it("reports the initial state of charge", () => {
    const power = new EmulatedPowerModel(0.5);
    expect(power.getSnapshot().level).toBeCloseTo(0.5, 5);
  });

  it("draws less in deep sleep than active, ignoring consumers", () => {
    const power = new EmulatedPowerModel();
    power.setEspMode(EspMode.Active);
    const active = power.getSnapshot().drawMa;
    power.setConsumer(PowerConsumer.Wifi, true);
    expect(power.getSnapshot().drawMa).toBeGreaterThan(active);

    power.setEspMode(EspMode.DeepSleep);
    expect(power.getSnapshot().drawMa).toBe(
      POWER_CONSTANTS.baseDrawMa[EspMode.DeepSleep],
    );
  });

  it("clamps sun exposure to 0..1", () => {
    const power = new EmulatedPowerModel();
    power.setSunExposure(5);
    expect(power.getSnapshot().sunExposure).toBe(1);
    power.setSunExposure(-2);
    expect(power.getSnapshot().sunExposure).toBe(0);
  });

  it("discharges when drawing more than it harvests", () => {
    const power = new EmulatedPowerModel(0.5);
    power.setEspMode(EspMode.Active);
    const before = power.getSnapshot().chargeMah;
    power.tick(ONE_HOUR_MS);
    const after = power.getSnapshot().chargeMah;
    expect(after).toBeLessThan(before);
  });

  it("charges from USB and clamps at capacity", () => {
    const power = new EmulatedPowerModel(0.9);
    power.setEspMode(EspMode.Active);
    power.setUsbConnected(true);
    expect(power.getSnapshot().charging).toBe(true);
    power.tick(ONE_HOUR_MS);
    expect(power.getSnapshot().chargeMah).toBe(POWER_CONSTANTS.capacityMah);
    expect(power.getSnapshot().level).toBe(1);
  });

  it("emits change when inputs move", () => {
    const power = new EmulatedPowerModel();
    let changes = 0;
    power.events.on("change", () => changes++);
    power.setSunExposure(0.5);
    power.setUsbConnected(true);
    expect(changes).toBe(2);
  });
});
