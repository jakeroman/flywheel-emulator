import { describe, expect, it } from "vitest";
import { Button } from "../hal/gamepad.js";
import { Gamepad } from "./gamepad.js";

describe("Gamepad", () => {
  it("tracks held state and emits change", () => {
    const pad = new Gamepad();
    let events = 0;
    pad.events.on("change", () => events++);

    pad.press(Button.A);
    expect(pad.isDown(Button.A)).toBe(true);
    expect(pad.getStates()[Button.A]).toBe(true);
    expect(events).toBe(1);

    pad.press(Button.A); // already down — no duplicate event
    expect(events).toBe(1);

    pad.release(Button.A);
    expect(pad.isDown(Button.A)).toBe(false);
    expect(events).toBe(2);
  });

  it("reports a held press as a single rising edge per frame", () => {
    const pad = new Gamepad();
    pad.press(Button.A);
    pad.poll();
    expect(pad.wasPressed(Button.A)).toBe(true);

    pad.poll(); // still held, no new edge
    expect(pad.wasPressed(Button.A)).toBe(false);
    expect(pad.isDown(Button.A)).toBe(true);

    pad.release(Button.A);
    pad.poll();
    expect(pad.wasReleased(Button.A)).toBe(true);
  });

  it("does not drop a press+release within a single frame (the latch fix)", () => {
    const pad = new Gamepad();
    pad.poll(); // baseline
    pad.press(Button.B);
    pad.release(Button.B); // tapped and released before the next poll
    pad.poll();
    expect(pad.wasPressed(Button.B)).toBe(true);
    expect(pad.wasReleased(Button.B)).toBe(true);
    expect(pad.isDown(Button.B)).toBe(false);
  });

  it("releaseAll clears everything and records release edges", () => {
    const pad = new Gamepad();
    pad.press(Button.Up);
    pad.press(Button.A);
    pad.releaseAll();
    pad.poll();
    expect(pad.isDown(Button.Up)).toBe(false);
    expect(pad.wasReleased(Button.Up)).toBe(true);
    expect(pad.wasReleased(Button.A)).toBe(true);
  });
});
