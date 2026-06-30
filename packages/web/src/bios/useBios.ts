import { useCallback, useEffect, useState } from "react";
import {
  Bios,
  type BiosSnapshot,
  type EmulatedFlywheelDevice,
} from "@flywheel/emulator-core";
// Bundle wasmoon's wasm locally (see useLuaController history) — keeps the app
// self-contained instead of fetching glue.wasm from a CDN.
import glueWasmUrl from "wasmoon/dist/glue.wasm?url";

const MAX_LOG_LINES = 200;

export interface BiosController {
  snapshot: BiosSnapshot;
  logs: string[];
  error: string | null;
  /** Dev shortcut: launch a script path as a game, bypassing the selector. */
  launchScript: (path: string) => Promise<void>;
  /** Return to the game selector (stopping a running game). */
  returnToMenu: () => void;
  clearLogs: () => void;
  /** The underlying BIOS, for the run loop. */
  bios: Bios;
}

/**
 * Owns the BIOS for the app's lifetime, mirrors its state/log/error events into
 * React, and wires the power switch to boot/shutdown.
 */
export function useBios(device: EmulatedFlywheelDevice): BiosController {
  const [bios] = useState(() => new Bios(device, { wasmUri: glueWasmUrl }));
  const [snapshot, setSnapshot] = useState<BiosSnapshot>(() => bios.snapshot());
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const offChange = bios.events.on("change", (s) => {
      setSnapshot(s);
      setError(s.error);
    });
    const offLog = bios.events.on("log", (m) =>
      setLogs((prev) => [...prev, m].slice(-MAX_LOG_LINES)),
    );
    const offError = bios.events.on("error", (m) => setError(m));
    const offPower = device.events.on("power", ({ poweredOn }) =>
      poweredOn ? bios.boot() : bios.shutdown(),
    );

    setSnapshot(bios.snapshot());
    if (device.poweredOn) bios.boot();

    return () => {
      offChange();
      offLog();
      offError();
      offPower();
      bios.dispose(); // free the wasmoon engine on unmount
    };
  }, [device, bios]);

  const launchScript = useCallback(
    async (path: string) => {
      setLogs([]);
      setError(null);
      await bios.launchScript(path);
    },
    [bios],
  );

  const returnToMenu = useCallback(() => bios.returnToMenu(), [bios]);
  const clearLogs = useCallback(() => setLogs([]), []);

  return {
    snapshot,
    logs,
    error,
    launchScript,
    returnToMenu,
    clearLogs,
    bios,
  };
}
