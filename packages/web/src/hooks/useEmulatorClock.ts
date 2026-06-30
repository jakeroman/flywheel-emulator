import { useEffect } from "react";
import type {
  EmulatedFlywheelDevice,
  LuaRuntime,
} from "@flywheel/emulator-core";

/** How often the energy balance is integrated (ms). */
const POWER_TICK_INTERVAL = 250;
/** Clamp per-frame dt so a backgrounded tab doesn't dump a huge step. */
const MAX_FRAME_MS = 100;

/**
 * The single host run loop. Each animation frame it: latches gamepad edges,
 * advances the running Lua script (update + draw), and integrates the power
 * energy balance on a coarser cadence. The gamepad is polled before the Lua
 * update so `fw.btnp` sees this frame's edges.
 */
export function useEmulatorClock(
  device: EmulatedFlywheelDevice,
  runtime: LuaRuntime,
): void {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let powerAccum = 0;

    const loop = (now: number) => {
      const dtMs = Math.min(now - last, MAX_FRAME_MS);
      last = now;

      device.gamepad.poll();

      // Lua only advances while the device is powered on; powering off pauses
      // the script (Phase 2's BIOS will own this boot/run lifecycle).
      if (device.poweredOn && runtime.status === "running") {
        const dt = dtMs / 1000;
        runtime.update(dt);
        runtime.draw();
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
  }, [device, runtime]);
}
