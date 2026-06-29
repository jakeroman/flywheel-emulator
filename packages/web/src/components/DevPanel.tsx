import { useEffect, useState } from "react";
import type { FileStat, SDCard } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import { usePoweredOn, usePowerSnapshot } from "../hooks/useDeviceStores.js";
import "./DevPanel.css";

/**
 * The development side panel. In Phase 0 it surfaces live device state and the
 * power inputs, plus a read-only view of the virtual SD card. Phases 1 and 3
 * grow this into the full editor / file manager / state inspector.
 */
export function DevPanel() {
  return (
    <div className="fw-devpanel" role="region" aria-label="Developer tools">
      <header className="fw-devpanel__head">
        <h2 className="fw-devpanel__title">DEV TOOLS</h2>
        <span className="fw-devpanel__phase">Phase 0</span>
      </header>

      <StatusSection />
      <PowerSection />
      <StorageSection />

      <section className="fw-section fw-section--muted">
        <h3 className="fw-section__title">Lua Editor</h3>
        <p className="fw-section__note">
          In-browser editor with hot-reload arrives in Phase 3.
        </p>
      </section>
    </div>
  );
}

function StatusSection() {
  const poweredOn = usePoweredOn();
  const power = usePowerSnapshot();
  return (
    <section className="fw-section">
      <h3 className="fw-section__title">Status</h3>
      <dl className="fw-stat">
        <Stat label="Power">
          <span className={poweredOn ? "fw-pill fw-pill--on" : "fw-pill"}>
            {poweredOn ? "ON" : "OFF"}
          </span>
        </Stat>
        <Stat label="Battery">{(power.level * 100).toFixed(1)}%</Stat>
        <Stat label="Voltage">{power.voltage.toFixed(2)} V</Stat>
        <Stat label="ESP mode">{power.espMode}</Stat>
      </dl>
    </section>
  );
}

function PowerSection() {
  const device = useDevice();
  const power = usePowerSnapshot();
  return (
    <section className="fw-section">
      <h3 className="fw-section__title">Power</h3>

      <div className="fw-battery" title={`${(power.level * 100).toFixed(0)}%`}>
        <div
          className={`fw-battery__fill${power.charging ? " is-charging" : ""}`}
          style={{ width: `${Math.round(power.level * 100)}%` }}
        />
      </div>

      <label className="fw-field">
        <span className="fw-field__label">
          Sun exposure
          <em>{Math.round(power.sunExposure * 100)}%</em>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={power.sunExposure}
          onChange={(e) =>
            device.power.setSunExposure(e.currentTarget.valueAsNumber)
          }
        />
      </label>

      <label className="fw-toggle">
        <input
          type="checkbox"
          checked={power.usbConnected}
          onChange={(e) =>
            device.power.setUsbConnected(e.currentTarget.checked)
          }
        />
        <span>USB charging</span>
      </label>

      <dl className="fw-stat fw-stat--compact">
        <Stat label="Draw">{power.drawMa.toFixed(1)} mA</Stat>
        <Stat label="Solar in">{power.solarMa.toFixed(1)} mA</Stat>
        <Stat label="USB in">{power.usbMa.toFixed(0)} mA</Stat>
        <Stat label="Net">
          <span
            className={
              power.netMa >= 0 ? "fw-net fw-net--pos" : "fw-net fw-net--neg"
            }
          >
            {power.netMa >= 0 ? "+" : ""}
            {power.netMa.toFixed(1)} mA
          </span>
        </Stat>
      </dl>
    </section>
  );
}

function StorageSection() {
  const device = useDevice();
  const entries = useSdTree(device.sd);
  return (
    <section className="fw-section">
      <h3 className="fw-section__title">SD Card</h3>
      {entries.length === 0 ? (
        <p className="fw-section__note">Empty.</p>
      ) : (
        <ul className="fw-tree">
          {entries.map((e) => (
            <li
              key={e.path}
              className="fw-tree__row"
              style={{ paddingLeft: `${e.depth * 14 + 4}px` }}
            >
              <span className="fw-tree__glyph">
                {e.type === "dir" ? "▸" : "·"}
              </span>
              <span className="fw-tree__name">{e.name}</span>
              {e.type === "file" && (
                <span className="fw-tree__size">{formatSize(e.size)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---- helpers --------------------------------------------------------- */

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fw-stat__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface TreeEntry extends FileStat {
  depth: number;
}

function useSdTree(sd: SDCard): TreeEntry[] {
  const [entries, setEntries] = useState<TreeEntry[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const flat = await walk(sd, "/", 0, []);
      if (alive) setEntries(flat);
    };
    void load();
    // The SDCard contract exposes a change emitter; refresh on any mutation.
    const off = sd.events.on("change", () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [sd]);

  return entries;
}

async function walk(
  sd: SDCard,
  path: string,
  depth: number,
  acc: TreeEntry[],
): Promise<TreeEntry[]> {
  const children = await sd.readDir(path);
  for (const child of children) {
    acc.push({ ...child, depth });
    if (child.type === "dir") await walk(sd, child.path, depth + 1, acc);
  }
  return acc;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
