import { useState } from "react";
import { DevPanel } from "./DevPanel.js";
import { ApiReference } from "./ApiReference.js";
import { EditorTab } from "../editor/EditorTab.js";
import "./Workspace.css";

type Tab = "editor" | "dev" | "api";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "editor", label: "Editor" },
  { id: "dev", label: "Dev" },
  { id: "api", label: "API" },
];

/**
 * The dev workspace beside the device. Tabs: the Editor (file tree + code
 * editor + run output — the edit-and-run loop), Dev (device status, power
 * controls, SD import/export, Lua/native launcher + console), and API (a static
 * reference for the `fw` API). All panes stay mounted so switching tabs
 * preserves editor and scroll state.
 */
export function Workspace() {
  const [tab, setTab] = useState<Tab>("editor");

  return (
    <div className="fw-workspace">
      {/* Plain toggle buttons (aria-pressed) rather than a half-implemented
          ARIA tablist — the full roving-tabindex tab pattern isn't wired. */}
      <div className="fw-workspace__tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            className={`fw-tab${tab === t.id ? " is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="fw-workspace__body">
        <div className="fw-workspace__pane" hidden={tab !== "editor"}>
          <EditorTab />
        </div>
        <div className="fw-workspace__pane" hidden={tab !== "dev"}>
          <DevPanel />
        </div>
        <div className="fw-workspace__pane" hidden={tab !== "api"}>
          <ApiReference />
        </div>
      </div>
    </div>
  );
}
