import { useDevice } from "../device/device-context.js";
import { usePoweredOn } from "../hooks/useDeviceStores.js";
import "./PowerSwitch.css";

/**
 * The physical power switch. Slides between OFF and ON and lights an indicator
 * when powered. Toggling drives the device's power-switch lifecycle, which the
 * BIOS (Phase 2) hooks into for boot.
 */
export function PowerSwitch() {
  const device = useDevice();
  const poweredOn = usePoweredOn();

  const toggle = () => {
    if (poweredOn) device.powerOff();
    else device.powerOn();
  };

  return (
    <div className="fw-power">
      <span className="fw-power__label">OFF</span>
      <button
        type="button"
        role="switch"
        aria-checked={poweredOn}
        aria-label="Power switch"
        className={`fw-power__switch${poweredOn ? " is-on" : ""}`}
        onClick={toggle}
      >
        <span className="fw-power__track" aria-hidden="true">
          <span className="fw-power__knob" />
        </span>
      </button>
      <span className="fw-power__label">ON</span>
      <span
        className={`fw-power__led${poweredOn ? " is-on" : ""}`}
        aria-hidden="true"
      />
    </div>
  );
}
