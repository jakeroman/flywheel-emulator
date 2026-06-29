import { useEffect } from "react";
import type { EmulatedFlywheelDevice } from "@flywheel/emulator-core";

/** How often the energy balance is integrated (ms). */
const POWER_TICK_INTERVAL = 250;

/**
 * Drives the device each animation frame: latches gamepad edges every frame
 * and advances the power energy balance on a coarser cadence (the battery
 * changes slowly, so there is no reason to re-render power readouts at 60fps).
 *
 * This is the single host run loop. When the Lua runtime arrives in Phase 1,
 * its per-frame callback hangs off this same loop.
 */
export function useEmulatorClock(device: EmulatedFlywheelDevice): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let powerAccum = 0;

    const loop = (now: number) => {
      const dt = now - last;
      last = now;

      device.gamepad.poll();

      powerAccum += dt;
      if (powerAccum >= POWER_TICK_INTERVAL) {
        device.tick(powerAccum);
        powerAccum = 0;
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [device]);
}
