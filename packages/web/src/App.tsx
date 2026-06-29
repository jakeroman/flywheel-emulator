import { useEffect, useState } from "react";
import {
  EmulatedFlywheelDevice,
  seedMockContent,
} from "@flywheel/emulator-core";
import { DeviceProvider } from "./device/device-context.js";
import { DeviceShell } from "./components/DeviceShell.js";
import { DevPanel } from "./components/DevPanel.js";
import { useEmulatorClock } from "./hooks/useEmulatorClock.js";
import { useKeyboardInput } from "./input/keyboard.js";
import { drawBootTestPattern } from "./boot/test-pattern.js";
import "./App.css";

export function App() {
  // One device instance for the app's lifetime.
  const [device] = useState(
    () => new EmulatedFlywheelDevice({ initialBatteryLevel: 0.78 }),
  );

  useEffect(() => {
    // Phase 0 mock content. A memory display retains its last image even when
    // off, so it's fine to show the boot pattern before power-on.
    drawBootTestPattern(device.display);
    void seedMockContent(device.sd);
  }, [device]);

  useEmulatorClock(device);
  useKeyboardInput(device);

  return (
    <DeviceProvider device={device}>
      <div className="fw-app">
        <header className="fw-app__header">
          <h1 className="fw-app__title">Flywheel Emulator</h1>
          <p className="fw-app__subtitle">
            ESP32-S3 handheld · development environment
          </p>
        </header>

        <main className="fw-app__stage">
          <DeviceShell />
        </main>

        <aside className="fw-app__panel">
          <DevPanel />
        </aside>
      </div>
    </DeviceProvider>
  );
}
