import { Emitter } from "../util/emitter.js";
import {
  ALL_BUTTONS,
  type Button,
  type ButtonStates,
  type GamepadDevice,
  type GamepadEvents,
} from "../hal/gamepad.js";

/**
 * Concrete gamepad. The UI drives press()/release() from pointer and keyboard
 * input; the run loop calls poll() once per frame to commit edges.
 *
 * Edges use an accumulator-commit model rather than diffing snapshots: presses
 * and releases that happen between two polls are accumulated, then committed to
 * the frame's edge sets by poll(). This guarantees a momentary tap that presses
 * AND releases within a single inter-poll interval is still reported exactly
 * once — a plain two-snapshot diff would lose it entirely.
 */
export class Gamepad implements GamepadDevice {
  readonly events = new Emitter<GamepadEvents>();

  /** Currently held buttons. */
  private down = new Set<Button>();

  /** Transitions accumulated since the last poll(). */
  private pressedSincePoll = new Set<Button>();
  private releasedSincePoll = new Set<Button>();

  /** Edges committed by the most recent poll(), read for the current frame. */
  private pressedEdges = new Set<Button>();
  private releasedEdges = new Set<Button>();

  press(button: Button): void {
    if (this.down.has(button)) return;
    this.down.add(button);
    this.pressedSincePoll.add(button);
    this.events.emit("change", this.getStates());
  }

  release(button: Button): void {
    if (!this.down.has(button)) return;
    this.down.delete(button);
    this.releasedSincePoll.add(button);
    this.events.emit("change", this.getStates());
  }

  /** Force a button to a specific state (used by keyboard handlers). */
  set(button: Button, on: boolean): void {
    if (on) this.press(button);
    else this.release(button);
  }

  /** Release everything (e.g. window blur, or power off). */
  releaseAll(): void {
    if (this.down.size === 0) return;
    for (const button of this.down) this.releasedSincePoll.add(button);
    this.down.clear();
    this.events.emit("change", this.getStates());
  }

  isDown(button: Button): boolean {
    return this.down.has(button);
  }

  wasPressed(button: Button): boolean {
    return this.pressedEdges.has(button);
  }

  wasReleased(button: Button): boolean {
    return this.releasedEdges.has(button);
  }

  getStates(): ButtonStates {
    const states = {} as Record<Button, boolean>;
    for (const button of ALL_BUTTONS) {
      states[button] = this.down.has(button);
    }
    return states;
  }

  poll(): void {
    this.pressedEdges = this.pressedSincePoll;
    this.releasedEdges = this.releasedSincePoll;
    this.pressedSincePoll = new Set();
    this.releasedSincePoll = new Set();
  }
}
