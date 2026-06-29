import { useEffect, useRef } from "react";
import type { DisplayDevice } from "@flywheel/emulator-core";
import { useDevice } from "../device/device-context.js";
import "./DisplayCanvas.css";

type RGB = readonly [number, number, number];

/**
 * Renders the Sharp memory display. The framebuffer is the source of truth;
 * this component just mirrors it to a canvas, repainting only when the
 * framebuffer's revision changes (the panel "holds" its image otherwise).
 * CSS overlays add the reflective sheen and edge vignette.
 */
export function DisplayCanvas() {
  const device = useDevice();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const display = device.display;
    canvas.width = display.width;
    canvas.height = display.height;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const image = ctx.createImageData(display.width, display.height);
    const colors = readDisplayColors();

    let lastRevision = -1;
    let raf = 0;
    const render = () => {
      const rev = display.revision;
      if (rev !== lastRevision) {
        lastRevision = rev;
        paint(display, image.data, colors);
        ctx.putImageData(image, 0, 0);
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [device]);

  return (
    <div className="fw-display">
      <div className="fw-display__bezel">
        <canvas ref={canvasRef} className="fw-display__canvas" />
        <div className="fw-display__vignette" aria-hidden="true" />
        <div className="fw-display__glare" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Write the packed 1bpp framebuffer into RGBA image data. */
function paint(
  display: DisplayDevice,
  data: Uint8ClampedArray,
  colors: { ink: RGB; ground: RGB },
): void {
  const W = display.width;
  const H = display.height;
  const buf = display.getPackedBuffer();
  const bytesPerRow = Math.ceil(W / 8);
  const { ink, ground } = colors;

  let di = 0;
  for (let y = 0; y < H; y++) {
    const rowBase = y * bytesPerRow;
    for (let x = 0; x < W; x++) {
      const byte = buf[rowBase + (x >> 3)];
      const on = (byte >> (7 - (x & 7))) & 1;
      const c = on ? ink : ground;
      data[di++] = c[0];
      data[di++] = c[1];
      data[di++] = c[2];
      data[di++] = 255;
    }
  }
}

/** Pull the ink/ground colors from the CSS design tokens so they stay in sync. */
function readDisplayColors(): { ink: RGB; ground: RGB } {
  const root = getComputedStyle(document.documentElement);
  return {
    ink: hexToRgb(root.getPropertyValue("--fw-display-ink"), [29, 35, 26]),
    ground: hexToRgb(
      root.getPropertyValue("--fw-display-ground"),
      [196, 201, 183],
    ),
  };
}

function hexToRgb(value: string, fallback: RGB): RGB {
  const hex = value.trim().replace("#", "");
  if (hex.length !== 6) return fallback;
  const n = Number.parseInt(hex, 16);
  if (Number.isNaN(n)) return fallback;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
