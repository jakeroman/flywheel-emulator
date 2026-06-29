import { DisplayCanvas } from "./DisplayCanvas.js";
import { Gamepad } from "./Gamepad.js";
import { PowerSwitch } from "./PowerSwitch.js";
import "./DeviceShell.css";

/**
 * The physical device body: a graphite handheld shell with the reflective
 * display up top, the gamepad below, and the power switch along the bottom.
 */
export function DeviceShell() {
  return (
    <div className="fw-device" role="group" aria-label="Flywheel handheld">
      <div className="fw-device__top">
        <span className="fw-device__brand">FLYWHEEL</span>
        <span
          className="fw-device__sun"
          title="Solar panel"
          aria-hidden="true"
        />
      </div>

      <DisplayCanvas />

      <div className="fw-device__controls">
        <Gamepad />
      </div>

      <div className="fw-device__footer">
        <PowerSwitch />
        <span className="fw-device__model">FW-01 · SOLAR</span>
      </div>
    </div>
  );
}
