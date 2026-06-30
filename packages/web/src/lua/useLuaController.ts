import { useCallback, useState } from "react";
import {
  LuaRuntime,
  type EmulatedFlywheelDevice,
  type LuaStatus,
} from "@flywheel/emulator-core";
// Bundle wasmoon's wasm as a local asset so the app stays self-contained
// (otherwise wasmoon fetches glue.wasm from a public CDN at runtime).
import glueWasmUrl from "wasmoon/dist/glue.wasm?url";

const MAX_LOG_LINES = 200;

export interface LuaController {
  runtime: LuaRuntime;
  status: LuaStatus;
  logs: string[];
  error: string | null;
  currentPath: string | null;
  /** Load and run the script at `path` from the SD card. */
  run: (path: string) => Promise<void>;
  stop: () => void;
  clearLogs: () => void;
}

/**
 * Owns the LuaRuntime for the app's lifetime and mirrors its callbacks
 * (log / error / status) into React state for the dev console.
 */
export function useLuaController(
  device: EmulatedFlywheelDevice,
): LuaController {
  const [status, setStatus] = useState<LuaStatus>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);

  const [runtime] = useState(
    () =>
      new LuaRuntime(
        device,
        {
          onLog: (message) =>
            setLogs((prev) => [...prev, message].slice(-MAX_LOG_LINES)),
          onError: (err) => setError(err.message),
          onStatus: (next) => setStatus(next),
        },
        { wasmUri: glueWasmUrl },
      ),
  );

  const run = useCallback(
    async (path: string) => {
      setError(null);
      setLogs([]);
      setCurrentPath(path);
      try {
        const source = device.sd.readTextFileSync(path);
        // Running a script powers the device on (the run loop is power-gated).
        device.powerOn();
        await runtime.load(source);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    },
    [device, runtime],
  );

  const stop = useCallback(() => {
    void runtime.dispose();
  }, [runtime]);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { runtime, status, logs, error, currentPath, run, stop, clearLogs };
}
