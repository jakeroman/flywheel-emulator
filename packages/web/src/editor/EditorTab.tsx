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

const decoder = new TextDecoder();

/** Heuristic: a NUL byte in the head means binary (don't edit as text). */
function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const FONT_MIN = 10;
const FONT_MAX = 24;
const FONT_KEY = "fw-editor-fs";

function readStoredFontSize(): number {
  const s =
    typeof localStorage !== "undefined"
      ? Number(localStorage.getItem(FONT_KEY))
      : NaN;
  return Number.isFinite(s) && s >= FONT_MIN && s <= FONT_MAX ? s : 12;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The directory part of an absolute path ("/games/a/x.lua" → "/games/a"). */
function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
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
  const [binarySize, setBinarySize] = useState<number | null>(null); // non-null = binary
  const [runOnSave, setRunOnSave] = useState(false);
  const [fontSize, setFontSize] = useState<number>(readStoredFontSize);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [lastDir, setLastDir] = useState("/games");
  const consoleRef = useRef<HTMLDivElement>(null);

  const binary = binarySize !== null;

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bios.logs, bios.error]);

  useEffect(() => {
    try {
      localStorage.setItem(FONT_KEY, String(fontSize));
    } catch {
      // storage unavailable — keep the in-session size
    }
  }, [fontSize]);

  // Rows whose folder (or any ancestor) is collapsed are hidden.
  const visible = files.filter(
    (e) => ![...collapsed].some((dir) => e.path.startsWith(dir + "/")),
  );
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = useCallback(
    (path: string) => {
      if (path === openPath) return; // already open
      if (dirty && !window.confirm("Discard unsaved changes?")) return;
      try {
        const bytes = device.sd.readFileSync(path);
        setOpenPath(path);
        setLastDir(dirOf(path));
        setDirty(false);
        if (isBinary(bytes)) {
          setBinarySize(bytes.length);
          setContent("");
        } else {
          setBinarySize(null);
          setContent(decoder.decode(bytes));
        }
      } catch {
        // ignore unreadable file
      }
    },
    [openPath, dirty, device],
  );

  const save = useCallback(() => {
    if (!openPath || binary || !dirty) return;
    device.sd.writeFileSync(openPath, content);
    setDirty(false);
    if (runOnSave && openPath.endsWith(".lua")) {
      void bios.launchScript(openPath);
    }
  }, [openPath, binary, dirty, content, runOnSave, device, bios]);

  const run = useCallback(() => {
    if (!openPath || binary || !openPath.endsWith(".lua")) return;
    if (dirty) {
      device.sd.writeFileSync(openPath, content);
      setDirty(false);
    }
    void bios.launchScript(openPath);
  }, [openPath, binary, dirty, content, device, bios]);

  // Default new files/folders into the folder you're working in (the open
  // file's dir, else the last one you touched) instead of always /games/.
  const workingDir = openPath ? dirOf(openPath) : lastDir;

  const newFile = () => {
    const raw = window.prompt("New file path", `${workingDir}/`);
    if (!raw) return;
    const path = raw.trim();
    if (!path.startsWith("/") || path.endsWith("/")) {
      window.alert("Enter an absolute file path, e.g. /games/foo.lua");
      return;
    }
    if (device.sd.existsSync(path)) {
      window.alert("A file or folder already exists at that path.");
      return;
    }
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    try {
      if (parent !== "/") device.sd.mkdirSync(parent, true);
      device.sd.writeFileSync(path, "");
      open(path);
    } catch (e) {
      window.alert(`Could not create: ${errMsg(e)}`);
    }
  };

  const newFolder = () => {
    const raw = window.prompt("New folder path", `${workingDir}/`);
    if (!raw) return;
    const path = raw.trim().replace(/\/+$/, "");
    if (!path.startsWith("/")) {
      window.alert("Enter an absolute folder path, e.g. /games/foo");
      return;
    }
    if (device.sd.existsSync(path)) {
      window.alert("A file or folder already exists at that path.");
      return;
    }
    try {
      device.sd.mkdirSync(path, true);
      setLastDir(path);
    } catch (e) {
      window.alert(`Could not create: ${errMsg(e)}`);
    }
  };

  const remove = (path: string) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    device.sd.removeSync(path);
    if (openPath === path || openPath?.startsWith(path + "/")) {
      setOpenPath(null);
      setContent("");
      setDirty(false);
      setBinarySize(null);
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
          disabled={!openPath || binary || !dirty}
        >
          Save
        </button>
        <button
          type="button"
          className="fw-minibtn fw-edit__run"
          onClick={run}
          disabled={!openPath || binary || !openPath.endsWith(".lua")}
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
        <div className="fw-edit__fs" role="group" aria-label="Editor font size">
          <button
            type="button"
            className="fw-minibtn"
            onClick={() => setFontSize((f) => clamp(f - 1, FONT_MIN, FONT_MAX))}
            disabled={fontSize <= FONT_MIN}
            aria-label="Smaller font"
            title="Smaller font"
          >
            A−
          </button>
          <button
            type="button"
            className="fw-minibtn"
            onClick={() => setFontSize((f) => clamp(f + 1, FONT_MIN, FONT_MAX))}
            disabled={fontSize >= FONT_MAX}
            aria-label="Larger font"
            title="Larger font"
          >
            A+
          </button>
        </div>
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
            {visible.map((e) => (
              <li
                key={e.path}
                className={`fw-tree__row${e.path === openPath ? " is-open" : ""}`}
                style={{ paddingLeft: `${e.depth * 12 + 4}px` }}
              >
                {e.type === "dir" ? (
                  <button
                    type="button"
                    className="fw-tree__dir"
                    title={e.path}
                    aria-expanded={!collapsed.has(e.path)}
                    onClick={() => toggleDir(e.path)}
                  >
                    <span className="fw-tree__glyph" aria-hidden="true">
                      {collapsed.has(e.path) ? "▸" : "▾"}
                    </span>
                    <span className="fw-tree__name">{e.name}</span>
                  </button>
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
          {openPath == null ? (
            <p className="fw-edit__empty">
              Select a file to edit, or create one. A <code>.lua</code> file can
              be run on the device (Run, or Ctrl-S with “run on save”).
            </p>
          ) : binary ? (
            <p className="fw-edit__empty">
              Binary file — {binarySize} bytes (not editable as text).
            </p>
          ) : (
            <Suspense
              fallback={
                <p className="fw-edit__empty" role="status">
                  Loading editor…
                </p>
              }
            >
              <CodeEditor
                value={content}
                fontSize={fontSize}
                onChange={(next) => {
                  setContent(next);
                  setDirty(true);
                }}
                onSave={save}
              />
            </Suspense>
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
