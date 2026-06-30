import { useEffect, useRef, useState } from "react";
import type { EmulatedFlywheelDevice } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import { useBiosController } from "../bios/bios-context.js";
import "./LuaPanel.css";

/**
 * Dev launcher + console. Games normally run via the on-device BIOS (power on →
 * selector → A), but this panel can launch any `.lua` directly for quick
 * iteration, and surfaces BIOS state, errors, and `print`/`fw.log` output. The
 * full in-browser editor with hot-reload lands in Phase 3.
 */
export function LuaPanel() {
  const device = useDevice();
  const bios = useBiosController();
  const files = useLuaFiles(device);
  const [selected, setSelected] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);

  const { snapshot, logs, error } = bios;
  const inGame = snapshot.screen === "game";

  useEffect(() => {
    if (files.length > 0 && !files.includes(selected)) setSelected(files[0]);
    if (files.length === 0 && selected !== "") setSelected("");
  }, [files, selected]);

  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <section className="fw-section">
      <h3 className="fw-section__title">Lua</h3>

      <div className="fw-lua__statusrow" aria-live="polite">
        <span className="fw-lua__badge">{snapshot.screen}</span>
        {inGame && (
          <span
            className={`fw-lua__badge fw-lua__badge--${snapshot.gameStatus}`}
          >
            {snapshot.gameStatus}
          </span>
        )}
        {snapshot.currentGameTitle && (
          <span className="fw-lua__path">{snapshot.currentGameTitle}</span>
        )}
      </div>

      <div className="fw-lua__controls">
        <select
          className="fw-lua__select"
          aria-label="Lua script"
          value={selected}
          onChange={(e) => setSelected(e.currentTarget.value)}
          disabled={files.length === 0}
        >
          {files.length === 0 ? (
            <option value="">no .lua files</option>
          ) : (
            files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))
          )}
        </select>
        <button
          type="button"
          className="fw-lua__btn fw-lua__run"
          onClick={() => selected && void bios.launchScript(selected)}
          disabled={!selected}
        >
          ▶ Launch
        </button>
        <button
          type="button"
          className="fw-lua__btn"
          onClick={() => bios.bios.returnToMenu()}
          disabled={!inGame}
          aria-label="Exit to menu"
          title="Exit to menu"
        >
          ■
        </button>
      </div>

      {error && (
        <pre className="fw-lua__error" role="alert">
          {error}
        </pre>
      )}

      <div className="fw-lua__consolehead">
        <span className="fw-lua__consolelabel">Console</span>
        <button
          type="button"
          className="fw-minibtn"
          onClick={bios.clearLogs}
          disabled={logs.length === 0}
        >
          Clear
        </button>
      </div>
      <div
        ref={consoleRef}
        className="fw-lua__console"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Lua console output"
      >
        {logs.length === 0 ? (
          <span className="fw-lua__empty">console output…</span>
        ) : (
          logs.map((line, i) => (
            <div key={i} className="fw-lua__line">
              {line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** All `.lua` file paths on the SD card, refreshed on any SD mutation. */
function useLuaFiles(device: EmulatedFlywheelDevice): string[] {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    const scan = () => {
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of device.sd.readDirSync(dir)) {
          if (entry.type === "dir") walk(entry.path);
          else if (entry.name.endsWith(".lua")) out.push(entry.path);
        }
      };
      try {
        walk("/");
      } catch {
        // Ignore — empty/uninitialized filesystem.
      }
      setFiles(out);
    };

    scan();
    const off = device.sd.events.on("change", scan);
    return () => off();
  }, [device]);

  return files;
}
