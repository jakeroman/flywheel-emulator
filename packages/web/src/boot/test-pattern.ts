import type { DisplayDevice } from "@flywheel/emulator-core";

/**
 * Phase 0 mock boot screen. Draws a recognizable pattern purely through the
 * DisplayDevice interface to prove the framebuffer → canvas pipeline works:
 * a border, a title bar, an ordered-dither grayscale ramp (showing the 1-bit
 * dithering aesthetic), a "flywheel" hub-and-spokes motif, and corner
 * registration marks. Text rendering arrives with the Phase 1 graphics layer.
 */
export function drawBootTestPattern(d: DisplayDevice): void {
  const W = d.width;
  const H = d.height;

  d.clear(false);

  // Outer border.
  rect(d, 2, 2, W - 4, H - 4);

  // Title bar (solid) with an inverted notch pattern.
  d.fillRect(8, 8, W - 16, 22, true);
  for (let x = 12; x < W - 12; x += 6) {
    d.fillRect(x, 12, 3, 14, false);
  }

  // Ordered-dither ramp: four density bands.
  const bandY = 40;
  const bandH = 34;
  const bandW = Math.floor((W - 32) / 4);
  for (let band = 0; band < 4; band++) {
    ditherRect(d, 16 + band * bandW, bandY, bandW - 4, bandH, band / 3);
  }

  // Flywheel hub + spokes, centered in the lower area.
  const cx = Math.floor(W / 2);
  const cy = 160;
  for (const r of [46, 44, 20, 18]) circle(d, cx, cy, r);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    line(
      d,
      cx + Math.round(Math.cos(a) * 19),
      cy + Math.round(Math.sin(a) * 19),
      cx + Math.round(Math.cos(a) * 45),
      cy + Math.round(Math.sin(a) * 45),
    );
  }
  d.fillRect(cx - 2, cy - 2, 4, 4, true);

  // Corner registration marks.
  for (const [mx, my] of [
    [10, 10],
    [W - 18, 10],
    [10, H - 18],
    [W - 18, H - 18],
  ] as const) {
    line(d, mx, my + 4, mx + 8, my + 4);
    line(d, mx + 4, my, mx + 4, my + 8);
  }
}

function rect(
  d: DisplayDevice,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  line(d, x, y, x + w - 1, y);
  line(d, x, y + h - 1, x + w - 1, y + h - 1);
  line(d, x, y, x, y + h - 1);
  line(d, x + w - 1, y, x + w - 1, y + h - 1);
}

/** Bresenham line. */
function line(
  d: DisplayDevice,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    d.setPixel(x0, y0, true);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Midpoint circle outline. */
function circle(d: DisplayDevice, cx: number, cy: number, r: number): void {
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    for (const [px, py] of [
      [x, y],
      [y, x],
      [-x, y],
      [-y, x],
      [-x, -y],
      [-y, -x],
      [x, -y],
      [y, -x],
    ] as const) {
      d.setPixel(cx + px, cy + py, true);
    }
    y++;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

/** 4x4 ordered-dither fill approximating a gray level (0..1). */
function ditherRect(
  d: DisplayDevice,
  x: number,
  y: number,
  w: number,
  h: number,
  level: number,
): void {
  const bayer = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const threshold = level * 16;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const on = bayer[py & 3][px & 3] < threshold;
      d.setPixel(x + px, y + py, on);
    }
  }
}
