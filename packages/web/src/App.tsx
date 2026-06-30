import { useEffect, useState } from "react";
import { EmulatedFlywheelDevice } from "@flywheel/emulator-core";
import { DeviceProvider } from "./device/device-context.js";
import { LuaProvider } from "./lua/lua-context.js";
import { useLuaController } from "./lua/useLuaController.js";
import { useSdPersistence } from "./storage/useSdPersistence.js";
import { WebAudioDevice } from "./audio/web-audio-device.js";
import { DeviceShell } from "./components/DeviceShell.js";
import { DevPanel } from "./components/DevPanel.js";
import { useEmulatorClock } from "./hooks/useEmulatorClock.js";
import { useKeyboardInput } from "./input/keyboard.js";
import { drawBootTestPattern } from "./boot/test-pattern.js";
import "./App.css";

export function App() {
  // Browser audio output, wired into the device's HAL audio slot.
  const [audio] = useState(() => new WebAudioDevice());
  const [device] = useState(
    () => new EmulatedFlywheelDevice({ initialBatteryLevel: 0.78, audio }),
  );
  const lua = useLuaController(device);

  // Persist the SD card to IndexedDB (seeds mock content on first run).
  useSdPersistence(device);

  useEffect(() => {
    // A memory display retains its last image even when off, so it's fine to
    // show the boot pattern before power-on.
    drawBootTestPattern(device.display);
  }, [device]);

  // Resume the AudioContext on the first user gesture (autoplay policy).
  useEffect(() => {
    const resume = () => void audio.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [audio]);

  useEmulatorClock(device, lua.runtime);
  useKeyboardInput(device);

  return (
    <DeviceProvider device={device}>
      <LuaProvider controller={lua}>
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
      </LuaProvider>
    </DeviceProvider>
  );
}
