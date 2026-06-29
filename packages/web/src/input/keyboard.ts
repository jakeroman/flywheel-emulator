import { useEffect } from "react";
import { Button, type EmulatedFlywheelDevice } from "@flywheel/emulator-core";

/**
 * Default keyboard → button mapping, keyed by KeyboardEvent.code so it is
 * independent of layout. WASD and the arrow keys both drive the D-pad.
 */
export const DEFAULT_KEYMAP: Readonly<Record<string, Button>> = {
  ArrowUp: Button.Up,
  KeyW: Button.Up,
  ArrowDown: Button.Down,
  KeyS: Button.Down,
  ArrowLeft: Button.Left,
  KeyA: Button.Left,
  ArrowRight: Button.Right,
  KeyD: Button.Right,

  KeyX: Button.A,
  KeyL: Button.A,
  Space: Button.A,

  KeyZ: Button.B,
  KeyK: Button.B,

  Enter: Button.Menu,
  KeyM: Button.Menu,

  ShiftLeft: Button.Select,
  ShiftRight: Button.Select,
  KeyN: Button.Select,
};

/** Human-readable key hints per button, for on-screen labels. */
export const KEY_HINTS: Readonly<Record<Button, string>> = {
  [Button.Up]: "↑ / W",
  [Button.Down]: "↓ / S",
  [Button.Left]: "← / A",
  [Button.Right]: "→ / D",
  [Button.A]: "X",
  [Button.B]: "Z",
  [Button.Menu]: "Enter",
  [Button.Select]: "Shift",
};

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Routes physical keyboard input into the emulated gamepad. Ignores keys while
 * a text field is focused (so the Phase 3 editor isn't hijacked) and releases
 * everything on window blur to avoid stuck buttons.
 */
export function useKeyboardInput(
  device: EmulatedFlywheelDevice,
  keymap: Readonly<Record<string, Button>> = DEFAULT_KEYMAP,
): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isTextEntry(e.target)) return;
      const button = keymap[e.code];
      if (!button) return;
      e.preventDefault();
      device.gamepad.press(button);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const button = keymap[e.code];
      if (!button) return;
      e.preventDefault();
      device.gamepad.release(button);
    };

    const onBlur = () => device.gamepad.releaseAll();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [device, keymap]);
}
