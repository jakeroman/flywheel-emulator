import { useState } from "react";
import { DevPanel } from "./DevPanel.js";
import { EditorTab } from "../editor/EditorTab.js";
import "./Workspace.css";

type Tab = "editor" | "dev";

/**
 * The dev workspace beside the device. Two tabs: the Editor (file tree + code
 * editor + run output — the edit-and-run loop) and Dev (device status, power
 * controls, SD import/export, Lua/native launcher + console). Both panes stay
 * mounted so switching tabs preserves editor and scroll state.
 */
export function Workspace() {
  const [tab, setTab] = useState<Tab>("editor");

  return (
    <div className="fw-workspace">
      {/* Plain toggle buttons (aria-pressed) rather than a half-implemented
          ARIA tablist — the full roving-tabindex tab pattern isn't wired. */}
      <div className="fw-workspace__tabs">
        <button
          type="button"
          aria-pressed={tab === "editor"}
          className={`fw-tab${tab === "editor" ? " is-active" : ""}`}
          onClick={() => setTab("editor")}
        >
          Editor
        </button>
        <button
          type="button"
          aria-pressed={tab === "dev"}
          className={`fw-tab${tab === "dev" ? " is-active" : ""}`}
          onClick={() => setTab("dev")}
        >
          Dev
        </button>
      </div>

      <div className="fw-workspace__body">
        <div className="fw-workspace__pane" hidden={tab !== "editor"}>
          <EditorTab />
        </div>
        <div className="fw-workspace__pane" hidden={tab !== "dev"}>
          <DevPanel />
        </div>
      </div>
    </div>
  );
}
