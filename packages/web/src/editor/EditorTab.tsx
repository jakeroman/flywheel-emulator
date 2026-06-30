import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EmulatedFlywheelDevice, FileStat } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import { useBiosController } from "../bios/bios-context.js";
import "./EditorTab.css";

// Lazy-load CodeMirror so its (large) bundle is only fetched once the user
// actually opens a file to edit.
const CodeEditor = lazy(() =>
  import("./CodeEditor.js").then((m) => ({ default: m.CodeEditor })),
);

interface TreeEntry extends FileStat {
  depth: number;
}

/**
 * The Phase 3 dev loop: pick a file from the SD card, edit it, and Save (or
 * Ctrl-S). With "run on save" on, saving a .lua file hot-reloads it on the
 * device — write Lua, see it run, iterate without leaving the page.
 */
export function EditorTab() {
  const device = useDevice();
  const bios = useBiosController();
  const files = useSdTree(device);

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [runOnSave, setRunOnSave] = useState(true);
  const consoleRef = useRef<HTMLDivElement>(null);

  // Autoscroll the run-output console to the newest line.
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bios.logs, bios.error]);

  const open = useCallback(
    (path: string) => {
      try {
        setContent(device.sd.readTextFileSync(path));
        setOpenPath(path);
        setDirty(false);
      } catch {
        // ignore unreadable file
      }
    },
    [device],
  );

  const save = useCallback(() => {
    if (!openPath) return;
    device.sd.writeFileSync(openPath, content);
    setDirty(false);
    if (runOnSave && openPath.endsWith(".lua")) {
      void bios.launchScript(openPath);
    }
  }, [openPath, content, runOnSave, device, bios]);

  const run = useCallback(() => {
    if (!openPath) return;
    if (dirty) device.sd.writeFileSync(openPath, content);
    setDirty(false);
    void bios.launchScript(openPath);
  }, [openPath, content, dirty, device, bios]);

  const newFile = () => {
    const path = window.prompt("New file path", "/games/");
    if (!path) return;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    try {
      if (parent !== "/") device.sd.mkdirSync(parent, true);
      device.sd.writeFileSync(path, "");
      open(path);
    } catch (e) {
      window.alert(`Could not create: ${e instanceof Error ? e.message : e}`);
    }
  };

  const newFolder = () => {
    const path = window.prompt("New folder path", "/games/");
    if (!path) return;
    try {
      device.sd.mkdirSync(path, true);
    } catch (e) {
      window.alert(`Could not create: ${e instanceof Error ? e.message : e}`);
    }
  };

  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    device.sd.removeSync(path);
    if (openPath === path || openPath?.startsWith(path + "/")) {
      setOpenPath(null);
      setContent("");
      setDirty(false);
    }
  };

  return (
    <div className="fw-edit">
      <div className="fw-edit__bar">
        <span className="fw-edit__name">
          {openPath ?? "no file open"}
          {dirty && <span className="fw-edit__dot" title="unsaved" />}
        </span>
        <button
          type="button"
          className="fw-minibtn"
          onClick={save}
          disabled={!openPath || !dirty}
        >
          Save
        </button>
        <button
          type="button"
          className="fw-minibtn fw-edit__run"
          onClick={run}
          disabled={!openPath || !openPath.endsWith(".lua")}
        >
          ▶ Run
        </button>
        <label className="fw-edit__toggle" title="Hot-reload on save">
          <input
            type="checkbox"
            checked={runOnSave}
            onChange={(e) => setRunOnSave(e.currentTarget.checked)}
          />
          run on save
        </label>
      </div>

      <div className="fw-edit__body">
        <div className="fw-edit__tree">
          <div className="fw-edit__treebar">
            <button type="button" className="fw-minibtn" onClick={newFile}>
              + File
            </button>
            <button type="button" className="fw-minibtn" onClick={newFolder}>
              + Dir
            </button>
          </div>
          <ul className="fw-tree">
            {files.map((e) => (
              <li
                key={e.path}
                className={`fw-tree__row${e.path === openPath ? " is-open" : ""}`}
                style={{ paddingLeft: `${e.depth * 12 + 4}px` }}
              >
                {e.type === "dir" ? (
                  <span className="fw-tree__glyph">▸</span>
                ) : (
                  <button
                    type="button"
                    className="fw-tree__file"
                    title={e.path}
                    onClick={() => open(e.path)}
                  >
                    {e.name}
                  </button>
                )}
                {e.type === "dir" && (
                  <span className="fw-tree__name">{e.name}</span>
                )}
                <button
                  type="button"
                  className="fw-tree__del"
                  aria-label={`Delete ${e.path}`}
                  title="Delete"
                  onClick={() => remove(e.path)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="fw-edit__main">
          {openPath ? (
            <Suspense
              fallback={<p className="fw-edit__empty">Loading editor…</p>}
            >
              <CodeEditor
                value={content}
                onChange={(next) => {
                  setContent(next);
                  setDirty(true);
                }}
                onSave={save}
              />
            </Suspense>
          ) : (
            <p className="fw-edit__empty">
              Select a file to edit, or create one. Save (Ctrl-S) a{" "}
              <code>.lua</code> file to run it on the device.
            </p>
          )}
        </div>
      </div>

      <div
        ref={consoleRef}
        className="fw-edit__console"
        role="log"
        aria-live="polite"
        aria-label="Run output"
      >
        {bios.error && <div className="fw-edit__err">{bios.error}</div>}
        {bios.logs.length === 0 && !bios.error ? (
          <span className="fw-edit__chint">run output…</span>
        ) : (
          bios.logs.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  );
}

function useSdTree(device: EmulatedFlywheelDevice): TreeEntry[] {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  useEffect(() => {
    const scan = () => {
      const out: TreeEntry[] = [];
      const walk = (dir: string, depth: number) => {
        for (const entry of device.sd.readDirSync(dir)) {
          out.push({ ...entry, depth });
          if (entry.type === "dir") walk(entry.path, depth + 1);
        }
      };
      try {
        walk("/", 0);
      } catch {
        // empty fs
      }
      setEntries(out);
    };
    scan();
    const off = device.sd.events.on("change", scan);
    return () => off();
  }, [device]);
  return entries;
}
