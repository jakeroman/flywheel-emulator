import { createContext, useContext, type ReactNode } from "react";
import type { LuaController } from "./useLuaController.js";

const LuaContext = createContext<LuaController | null>(null);

export function LuaProvider({
  controller,
  children,
}: {
  controller: LuaController;
  children: ReactNode;
}) {
  return (
    <LuaContext.Provider value={controller}>{children}</LuaContext.Provider>
  );
}

/** Access the Lua run controller. Throws outside a LuaProvider. */
export function useLua(): LuaController {
  const controller = useContext(LuaContext);
  if (!controller) {
    throw new Error("useLua must be used within a <LuaProvider>");
  }
  return controller;
}
