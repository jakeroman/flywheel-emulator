import type { Bitmap, DisplayDevice } from "../hal/display.js";
import {
  FONT_5X7,
  GLYPH_ADVANCE,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  LINE_HEIGHT,
} from "./font5x7.js";

/**
 * A small 1-bit drawing toolkit over a DisplayDevice. This is the layer the
 * BIOS and the Lua `fw.gfx` API draw through — primitives plus text in the
 * built-in 5x7 font. It owns no pixel storage; everything routes to the
 * display's setPixel/fillRect so dirty-row tracking and the bistable
 * hold-image behavior are preserved.
 *
 * Color is a single `fill` value from light to dark, which also fakes gray on
 * the 1-bit panel via an ordered 4x4 Bayer pattern:
 *   fill 0   = light (the reflective ground)
 *   fill 1   = dark (solid ink)
 *   fill 0.5 = 50% gray (checkerboard), etc.
 * `true`/`false` are accepted as 1/0 for convenience. Solid ends (0 and 1) take
 * a fast whole-rect path; intermediate shades render per-pixel. Draw ops default
 * to fill 1 (solid ink); `clear` defaults to fill 0 (light).
 */
export type Fill = number | boolean;

export class Graphics {
  constructor(private readonly display: DisplayDevice) {}

  get width(): number {
    return this.display.width;
  }
  get height(): number {
    return this.display.height;
  }

  /** Fill the whole display (defaults to clearing to the light ground). */
  clear(fill: Fill = 0): void {
    const t = fillThreshold(toFill(fill));
    if (t <= 0) {
      this.display.clear(false);
      return;
    }
    if (t >= BAYER_LEVELS) {
      this.display.clear(true);
      return;
    }
    this.fillRegion(0, 0, this.width, this.height, t);
  }

  pixel(x: number, y: number, fill: Fill = 1): void {
    this.plot(Math.round(x), Math.round(y), fillThreshold(toFill(fill)));
  }

  get(x: number, y: number): boolean {
    return this.display.getPixel(Math.round(x), Math.round(y));
  }

  hline(x: number, y: number, w: number, fill: Fill = 1): void {
    this.fillRegion(
      Math.round(x),
      Math.round(y),
      Math.round(w),
      1,
      fillThreshold(toFill(fill)),
    );
  }

  vline(x: number, y: number, h: number, fill: Fill = 1): void {
    this.fillRegion(
      Math.round(x),
      Math.round(y),
      1,
      Math.round(h),
      fillThreshold(toFill(fill)),
    );
  }

  /** Outlined rectangle. */
  rect(x: number, y: number, w: number, h: number, fill: Fill = 1): void {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    if (w <= 0 || h <= 0) return;
    const t = fillThreshold(toFill(fill));
    this.fillRegion(x, y, w, 1, t);
    this.fillRegion(x, y + h - 1, w, 1, t);
    this.fillRegion(x, y, 1, h, t);
    this.fillRegion(x + w - 1, y, 1, h, t);
  }

  /** Filled rectangle. */
  rectFill(x: number, y: number, w: number, h: number, fill: Fill = 1): void {
    this.fillRegion(
      Math.round(x),
      Math.round(y),
      Math.round(w),
      Math.round(h),
      fillThreshold(toFill(fill)),
    );
  }

  /** Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, fill: Fill = 1): void {
    // Guard against non-finite endpoints (the loop below would never end).
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1))
      return;
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    // Fully off-screen → nothing to draw (a line lies within its bounding box).
    // A partially visible line still walks its full length: clipping a Bresenham
    // line without shifting its exact pixel sequence is not a cheap change.
    if (
      this.offDisplay(
        Math.min(x0, x1),
        Math.min(y0, y1),
        Math.abs(x1 - x0) + 1,
        Math.abs(y1 - y0) + 1,
      )
    )
      return;
    const t = fillThreshold(toFill(fill));
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.plot(x0, y0, t);
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
  circle(cx: number, cy: number, r: number, fill: Fill = 1): void {
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(r)) return;
    cx = Math.round(cx);
    cy = Math.round(cy);
    r = Math.round(r);
    if (r < 0) return;
    // Skip when no outline pixel can land on screen — the whole viewport is
    // inside the ring (huge circle centered near it) or beyond it. A partially
    // visible arc still walks its ~r points; a bit-identical scanline outline
    // isn't available (a sqrt-based one differs at the octant seams).
    if (this.ringMisses(cx, cy, r)) return;
    const t = fillThreshold(toFill(fill));
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      this.eightfold(cx, cy, x, y, t);
      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  /** Filled circle (scanline per vertical offset). */
  circleFill(cx: number, cy: number, r: number, fill: Fill = 1): void {
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(r)) return;
    cx = Math.round(cx);
    cy = Math.round(cy);
    r = Math.round(r);
    if (r < 0) return;
    if (this.offDisplay(cx - r, cy - r, 2 * r + 1, 2 * r + 1)) return;
    const t = fillThreshold(toFill(fill));
    // Scan only the rows that land on screen (row cy+dy in [0, height));
    // fillRegion clips each scanline's x-span. This turns an O(r) vertical scan
    // (4001 iterations at r=2000) into O(min(r, height)) — the offscreen-cull.
    const dyStart = Math.max(-r, -cy);
    const dyEnd = Math.min(r, this.display.height - 1 - cy);
    for (let dy = dyStart; dy <= dyEnd; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      this.fillRegion(cx - dx, cy + dy, dx * 2 + 1, 1, t);
    }
  }

  /** Copy a 1bpp bitmap to (x, y). */
  blit(
    bitmap: Bitmap,
    x: number,
    y: number,
    options?: { transparent?: boolean; invert?: boolean },
  ): void {
    this.display.blit(bitmap, Math.round(x), Math.round(y), options);
  }

  /**
   * Draw one glyph; returns the x advance. Unknown glyphs render as a box.
   * `scale` (a positive integer, clamped) magnifies each font pixel into a
   * scale×scale block, so text can be drawn 2x, 3x, … larger. `fill` shades it
   * like the other primitives.
   */
  drawChar(
    ch: string,
    x: number,
    y: number,
    fill: Fill = 1,
    scale = 1,
  ): number {
    const s = intScale(scale);
    this.drawGlyph(
      ch,
      Math.round(x),
      Math.round(y),
      fillThreshold(toFill(fill)),
      s,
    );
    return GLYPH_ADVANCE * s;
  }

  /** Render one glyph at an already-resolved integer threshold + scale (shared
   *  by drawChar and print so the fill→threshold conversion happens once). */
  private drawGlyph(
    ch: string,
    x: number,
    y: number,
    threshold: number,
    s: number,
  ): void {
    const glyph = FONT_5X7[ch] ?? FONT_5X7["�"];
    if (!glyph) return;
    for (let row = 0; row < glyph.length; row++) {
      const line = glyph[row];
      for (let col = 0; col < line.length; col++) {
        if (line[col] !== " " && line[col] !== ".") {
          if (s === 1) this.plot(x + col, y + row, threshold);
          else this.fillRegion(x + col * s, y + row * s, s, s, threshold);
        }
      }
    }
  }

  /**
   * Draw text starting at (x, y). Handles "\n". `fill` shades it; `scale`
   * magnifies the text by a positive integer factor (line height and advance
   * scale with it). Returns the cursor position after the last character.
   */
  print(
    text: string,
    x: number,
    y: number,
    fill: Fill = 1,
    scale = 1,
  ): { x: number; y: number } {
    const s = intScale(scale);
    const t = fillThreshold(toFill(fill)); // once for the whole string
    const startX = Math.round(x);
    let cx = startX;
    let cy = Math.round(y);
    for (const ch of text) {
      if (ch === "\n") {
        cx = startX;
        cy += LINE_HEIGHT * s;
        continue;
      }
      this.drawGlyph(ch, cx, cy, t, s);
      cx += GLYPH_ADVANCE * s;
    }
    return { x: cx, y: cy };
  }

  /** Pixel width of a single line of text at `scale` (no newline handling). */
  textWidth(text: string, scale = 1): number {
    return text.length * GLYPH_ADVANCE * intScale(scale);
  }

  // ---- internal pixel writers (apply the dither pattern) ---------------
  //
  // These take a precomputed INTEGER Bayer threshold (0..16), not the float
  // fill: each public op converts fill→threshold ONCE via fillThreshold(), so
  // the per-pixel test is a pure integer array-lookup + compare (no float in the
  // hot loop). A pixel is ink when its Bayer value is below the threshold, and
  // the pattern is keyed to absolute display coordinates so it never shimmers
  // under moving content.

  /** Write one pixel: ink when its Bayer value is below `threshold`. */
  private plot(x: number, y: number, threshold: number): void {
    this.display.setPixel(
      x,
      y,
      BAYER_4X4[(y & BAYER_MASK) * BAYER_DIM + (x & BAYER_MASK)] < threshold,
    );
  }

  /** Fill a rectangle at Bayer `threshold` (0..16). Solid ends (0 = all light,
   *  16 = all dark) take the fast whole-rect path; an intermediate shade renders
   *  per-pixel — integer-only — in absolute display coordinates.
   *
   *  The rect is CLIPPED to the display first. Off-screen pixels are discarded by
   *  the framebuffer anyway, so clipping changes nothing visually, but it keeps
   *  the per-pixel dither loop O(on-screen area) instead of O(shape area) — the
   *  win when a shape is far larger than the screen (e.g. a zoomed-in circle with
   *  radius ≫ display). The Bayer pattern is keyed to absolute coords and every
   *  surviving pixel keeps its absolute (px&3, py&3), so the result is identical. */
  private fillRegion(
    x: number,
    y: number,
    w: number,
    h: number,
    threshold: number,
  ): void {
    // Clip to the display, failing closed on non-finite extents: Math.min(W,NaN)
    // is NaN and `!(x1 > x0)` is then true, so a NaN width/height draws nothing
    // (matching the pre-clip behavior) while staying identical for finite inputs.
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.display.width, x + w);
    const y1 = Math.min(this.display.height, y + h);
    if (!(x1 > x0) || !(y1 > y0)) return; // empty / non-finite → nothing on screen
    if (threshold <= 0) {
      this.display.fillRect(x0, y0, x1 - x0, y1 - y0, false);
      return;
    }
    if (threshold >= BAYER_LEVELS) {
      this.display.fillRect(x0, y0, x1 - x0, y1 - y0, true);
      return;
    }
    for (let py = y0; py < y1; py++) {
      const row = (py & BAYER_MASK) * BAYER_DIM; // hoist the row base out of x
      for (let px = x0; px < x1; px++) {
        this.display.setPixel(
          px,
          py,
          BAYER_4X4[row + (px & BAYER_MASK)] < threshold,
        );
      }
    }
  }

  /** True when a w×h box at (x,y) lies entirely off the display — a cheap reject
   *  so a fully off-screen shape does no per-pixel work at all. */
  private offDisplay(x: number, y: number, w: number, h: number): boolean {
    return (
      x + w <= 0 ||
      y + h <= 0 ||
      x >= this.display.width ||
      y >= this.display.height
    );
  }

  /** True when a circle *outline* of radius r at (cx,cy) can't touch the display:
   *  the whole screen is strictly inside the ring's inner edge (a huge circle
   *  centered near the viewport) or beyond its outer edge. Compares the
   *  nearest/farthest display-pixel distance² to (r∓2)² — a 2px margin that
   *  safely covers the midpoint algorithm's sub-pixel rounding, so it never skips
   *  a circle that has a visible outline pixel. */
  private ringMisses(cx: number, cy: number, r: number): boolean {
    const W = this.display.width;
    const H = this.display.height;
    // Nearest on-screen column/row distance (0 when the center is within range).
    const nx = cx < 0 ? -cx : cx > W - 1 ? cx - (W - 1) : 0;
    const ny = cy < 0 ? -cy : cy > H - 1 ? cy - (H - 1) : 0;
    const fx = Math.max(Math.abs(cx), Math.abs(cx - (W - 1)));
    const fy = Math.max(Math.abs(cy), Math.abs(cy - (H - 1)));
    const near2 = nx * nx + ny * ny;
    const far2 = fx * fx + fy * fy;
    const inner = r - 2;
    const outer = r + 2;
    return (inner > 0 && far2 < inner * inner) || near2 > outer * outer;
  }

  private eightfold(
    cx: number,
    cy: number,
    x: number,
    y: number,
    threshold: number,
  ): void {
    this.plot(cx + x, cy + y, threshold);
    this.plot(cx + y, cy + x, threshold);
    this.plot(cx - x, cy + y, threshold);
    this.plot(cx - y, cy + x, threshold);
    this.plot(cx - x, cy - y, threshold);
    this.plot(cx - y, cy - x, threshold);
    this.plot(cx + x, cy - y, threshold);
    this.plot(cx + y, cy - x, threshold);
  }
}

/**
 * 4x4 Bayer ordered-dither thresholds (0..15), row-major — INTEGERS. A pixel is
 * ink when its Bayer value is below the fill's integer threshold, giving 17 even
 * gray steps. Negative coordinates wrap correctly (`& BAYER_MASK` on
 * two's-complement), so the pattern is anchored to absolute display coords.
 */
const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER_DIM = 4; // matrix is 4x4 (a power of two → mask instead of %)
const BAYER_MASK = BAYER_DIM - 1; // 3
const BAYER_LEVELS = BAYER_DIM * BAYER_DIM; // 16

/**
 * Convert a fill (0..1) to its integer Bayer threshold, ONCE per draw call. A
 * pixel is ink when `bayer < threshold`, which reproduces the exact pattern of
 * the reference `fill*16 > bayer` comparison: for integer bayer, `bayer <
 * ceil(fill*16)` ⟺ `bayer < fill*16`. Range 0 (all light) .. 16 (all dark).
 * `| 0` keeps it a machine int (SMI), so the per-pixel compare stays integer.
 */
function fillThreshold(f: number): number {
  return Math.ceil(f * BAYER_LEVELS) | 0;
}

/** Resolve a Fill (number 0..1, or boolean 1/0) to a clamped number; NaN → 0. */
function toFill(v: Fill): number {
  if (v === true) return 1;
  if (v === false) return 0;
  if (!(v > 0)) return 0; // ≤ 0 or NaN → light
  return v >= 1 ? 1 : v;
}

/** Clamp a text scale to a positive integer (floor; minimum 1). */
function intScale(scale: number): number {
  const s = Math.floor(scale);
  return s >= 1 ? s : 1;
}

export { GLYPH_WIDTH, GLYPH_HEIGHT, GLYPH_ADVANCE, LINE_HEIGHT };
