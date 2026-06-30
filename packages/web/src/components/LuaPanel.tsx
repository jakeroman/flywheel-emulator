import { useEffect, useRef, useState } from "react";
import type { EmulatedFlywheelDevice } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import { useLua } from "../lua/lua-context.js";
import "./LuaPanel.css";

/**
 * Phase 1 Lua run panel: pick a `.lua` file from the SD card, run it on the
 * device, and watch status / errors / console output. The full in-browser
 * editor with hot-reload lands in Phase 3.
 */
export function LuaPanel() {
  const device = useDevice();
  const lua = useLua();
  const files = useLuaFiles(device);
  const [selected, setSelected] = useState("");
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (files.length > 0 && !files.includes(selected)) setSelected(files[0]);
    if (files.length === 0 && selected !== "") setSelected("");
  }, [files, selected]);

  // Autoscroll the console to the newest line, unless the user has scrolled up.
  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lua.logs]);

  return (
    <section className="fw-section">
      <h3 className="fw-section__title">Lua</h3>

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
          onClick={() => selected && void lua.run(selected)}
          disabled={!selected}
        >
          ▶ Run
        </button>
        <button
          type="button"
          className="fw-lua__btn"
          onClick={lua.stop}
          disabled={lua.status !== "running"}
          aria-label="Stop"
          title="Stop"
        >
          ■
        </button>
      </div>

      <div className="fw-lua__statusrow" aria-live="polite">
        <span className={`fw-lua__badge fw-lua__badge--${lua.status}`}>
          {lua.status}
        </span>
        {lua.currentPath && (
          <span className="fw-lua__path">{lua.currentPath}</span>
        )}
      </div>

      {lua.error && (
        <pre className="fw-lua__error" role="alert">
          {lua.error}
        </pre>
      )}

      <div className="fw-lua__consolehead">
        <span className="fw-lua__consolelabel">Console</span>
        <button
          type="button"
          className="fw-minibtn"
          onClick={lua.clearLogs}
          disabled={lua.logs.length === 0}
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
        {lua.logs.length === 0 ? (
          <span className="fw-lua__empty">console output…</span>
        ) : (
          lua.logs.map((line, i) => (
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
