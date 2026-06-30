import { useEffect } from "react";
import type { Bios, EmulatedFlywheelDevice } from "@flywheel/emulator-core";

/** How often the energy balance is integrated (ms). */
const POWER_TICK_INTERVAL = 250;
/** Clamp per-frame dt so a backgrounded tab doesn't dump a huge step. */
const MAX_FRAME_MS = 100;

/**
 * The single host run loop. Each animation frame it: latches gamepad edges,
 * advances the BIOS (which renders menus or delegates to the running Lua game),
 * and integrates the power energy balance on a coarser cadence. The gamepad is
 * polled before the BIOS update so input edges are seen this frame. The BIOS
 * only does anything while the device is powered on.
 */
export function useEmulatorClock(
  device: EmulatedFlywheelDevice,
  bios: Bios,
): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let powerAccum = 0;

    const loop = (now: number) => {
      const dtMs = Math.min(now - last, MAX_FRAME_MS);
      last = now;

      device.gamepad.poll();

      if (device.poweredOn) {
        const dt = dtMs / 1000;
        bios.update(dt);
        bios.draw();
      }

      powerAccum += dtMs;
      if (powerAccum >= POWER_TICK_INTERVAL) {
        device.tick(powerAccum);
        powerAccum = 0;
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [device, bios]);
}
