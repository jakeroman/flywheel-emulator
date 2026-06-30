import { createContext, useContext, type ReactNode } from "react";
import type { BiosController } from "./useBios.js";

const BiosContext = createContext<BiosController | null>(null);

export function BiosProvider({
  controller,
  children,
}: {
  controller: BiosController;
  children: ReactNode;
}) {
  return (
    <BiosContext.Provider value={controller}>{children}</BiosContext.Provider>
  );
}

/** Access the BIOS controller. Throws outside a BiosProvider. */
export function useBiosController(): BiosController {
  const controller = useContext(BiosContext);
  if (!controller) {
    throw new Error("useBiosController must be used within a <BiosProvider>");
  }
  return controller;
}
