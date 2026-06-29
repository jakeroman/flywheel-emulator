import type { Emitter } from "../util/emitter.js";

/**
 * Gamepad abstraction.
 *
 * The Flywheel has a Game Boy-style layout: a 4-way D-pad plus A, B, and the
 * two system buttons Menu and Select. The BIOS and Lua poll button state each
 * frame and also care about edges (press/release), so the device tracks both
 * the current held set and the transitions since the previous poll.
 */

export const Button = {
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  A: "A",
  B: "B",
  Menu: "Menu",
  Select: "Select",
} as const;

export type Button = (typeof Button)[keyof typeof Button];

/** Every button in a stable order, useful for iteration and UI layout. */
export const ALL_BUTTONS: readonly Button[] = [
  Button.Up,
  Button.Down,
  Button.Left,
  Button.Right,
  Button.A,
  Button.B,
  Button.Menu,
  Button.Select,
];

export type ButtonStates = Readonly<Record<Button, boolean>>;

export interface GamepadEvents {
  /** Fired whenever the held-button set changes (for live UI feedback). */
  change: ButtonStates;
}

export interface GamepadDevice {
  /** Live change notifications for observers (UI, dev tools). */
  readonly events: Emitter<GamepadEvents>;

  /** Is the button currently held down? */
  isDown(button: Button): boolean;
  /** Did the button see a rising edge since the previous poll()? */
  wasPressed(button: Button): boolean;
  /** Did the button see a falling edge since the previous poll()? */
  wasReleased(button: Button): boolean;
  /** Snapshot of all current button states. */
  getStates(): ButtonStates;

  /**
   * Latch edges for this frame. Call once per frame, BEFORE the frame's
   * game/BIOS update reads edges. wasPressed/wasReleased then report every
   * transition that occurred since the previous poll() — including a momentary
   * tap that both pressed and released within a single inter-poll interval.
   */
  poll(): void;
}
