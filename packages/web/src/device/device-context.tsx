import { createContext, useContext, type ReactNode } from "react";
import type { EmulatedFlywheelDevice } from "@flywheel/emulator-core";

const DeviceContext = createContext<EmulatedFlywheelDevice | null>(null);

export function DeviceProvider({
  device,
  children,
}: {
  device: EmulatedFlywheelDevice;
  children: ReactNode;
}) {
  return (
    <DeviceContext.Provider value={device}>{children}</DeviceContext.Provider>
  );
}

/** Access the emulated device. Throws if used outside a DeviceProvider. */
export function useDevice(): EmulatedFlywheelDevice {
  const device = useContext(DeviceContext);
  if (!device) {
    throw new Error("useDevice must be used within a <DeviceProvider>");
  }
  return device;
}
