import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { Button } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import { useGamepadState } from "../hooks/useDeviceStores.js";
import { KEY_HINTS } from "../input/keyboard.js";
import "./Gamepad.css";

/**
 * Game Boy-style controls: a 4-way D-pad, A/B face buttons, and the Menu /
 * Select system buttons. Pointer input drives press/release directly; the
 * pressed visual reflects the gamepad state from any source, so physical
 * keyboard presses light up the on-screen buttons too.
 */
export function Gamepad() {
  const states = useGamepadState();

  return (
    <div className="fw-gamepad">
      <div className="fw-dpad">
        <PadButton
          button={Button.Up}
          pressed={states[Button.Up]}
          className="fw-dpad__btn fw-dpad__up"
        >
          <Chevron dir="up" />
        </PadButton>
        <PadButton
          button={Button.Left}
          pressed={states[Button.Left]}
          className="fw-dpad__btn fw-dpad__left"
        >
          <Chevron dir="left" />
        </PadButton>
        <div className="fw-dpad__center" aria-hidden="true" />
        <PadButton
          button={Button.Right}
          pressed={states[Button.Right]}
          className="fw-dpad__btn fw-dpad__right"
        >
          <Chevron dir="right" />
        </PadButton>
        <PadButton
          button={Button.Down}
          pressed={states[Button.Down]}
          className="fw-dpad__btn fw-dpad__down"
        >
          <Chevron dir="down" />
        </PadButton>
      </div>

      <div className="fw-face">
        <PadButton
          button={Button.B}
          pressed={states[Button.B]}
          className="fw-face__btn fw-face__b"
        >
          B
        </PadButton>
        <PadButton
          button={Button.A}
          pressed={states[Button.A]}
          className="fw-face__btn fw-face__a"
        >
          A
        </PadButton>
      </div>

      <div className="fw-system">
        <PadButton
          button={Button.Select}
          pressed={states[Button.Select]}
          className="fw-system__btn"
        >
          SELECT
        </PadButton>
        <PadButton
          button={Button.Menu}
          pressed={states[Button.Menu]}
          className="fw-system__btn"
        >
          MENU
        </PadButton>
      </div>
    </div>
  );
}

function PadButton({
  button,
  pressed,
  className,
  children,
}: {
  button: Button;
  pressed: boolean;
  className: string;
  children: ReactNode;
}) {
  const device = useDevice();

  const press = (e: PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    device.gamepad.press(button);
  };
  const release = () => device.gamepad.release(button);

  // Keep the on-screen buttons operable for keyboard / assistive-tech users:
  // Space/Enter act as press-and-hold (WCAG 2.1.1). These are momentary push
  // buttons, so there is no toggle state and no aria-pressed.
  const keyDown = (e: KeyboardEvent) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      // Stop the global keyboard handler from also mapping this Space/Enter.
      e.stopPropagation();
      device.gamepad.press(button);
    }
  };
  const keyUp = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      device.gamepad.release(button);
    }
  };

  return (
    <button
      type="button"
      className={`fw-btn ${className}${pressed ? " is-pressed" : ""}`}
      aria-label={`${button} (${KEY_HINTS[button]})`}
      title={`${button} — ${KEY_HINTS[button]}`}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

function Chevron({ dir }: { dir: "up" | "down" | "left" | "right" }) {
  return (
    <span className={`fw-chevron fw-chevron--${dir}`} aria-hidden="true" />
  );
}
