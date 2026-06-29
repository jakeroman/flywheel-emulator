import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ButtonStates, PowerSnapshot } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";

/**
 * React bindings over the core's emitters. Each hook caches the latest
 * snapshot and only swaps the reference when the relevant event fires, so
 * useSyncExternalStore stays stable (no render loops).
 *
 * On (re)subscribe each hook re-reads the live state and notifies once, so any
 * change that happened between render and effect-commit — or across a
 * StrictMode unmount/remount — is reconciled rather than silently dropped.
 */

export function useGamepadState(): ButtonStates {
  const device = useDevice();
  const cache = useRef<ButtonStates>(device.gamepad.getStates());

  const subscribe = useCallback(
    (onChange: () => void) => {
      cache.current = device.gamepad.getStates();
      onChange();
      return device.gamepad.events.on("change", (states) => {
        cache.current = states;
        onChange();
      });
    },
    [device],
  );

  return useSyncExternalStore(
    subscribe,
    () => cache.current,
    () => cache.current,
  );
}

export function usePowerSnapshot(): PowerSnapshot {
  const device = useDevice();
  const cache = useRef<PowerSnapshot>(device.power.getSnapshot());

  const subscribe = useCallback(
    (onChange: () => void) => {
      cache.current = device.power.getSnapshot();
      onChange();
      return device.power.events.on("change", (snap) => {
        cache.current = snap;
        onChange();
      });
    },
    [device],
  );

  return useSyncExternalStore(
    subscribe,
    () => cache.current,
    () => cache.current,
  );
}

export function usePoweredOn(): boolean {
  const device = useDevice();
  const cache = useRef<boolean>(device.poweredOn);

  const subscribe = useCallback(
    (onChange: () => void) => {
      cache.current = device.poweredOn;
      onChange();
      return device.events.on("power", ({ poweredOn }) => {
        cache.current = poweredOn;
        onChange();
      });
    },
    [device],
  );

  return useSyncExternalStore(
    subscribe,
    () => cache.current,
    () => cache.current,
  );
}
