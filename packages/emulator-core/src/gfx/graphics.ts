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
 * Convention: `on = true` paints a dark pixel (ink); `false` clears to the
 * light reflective ground.
 */
export class Graphics {
  constructor(private readonly display: DisplayDevice) {}

  get width(): number {
    return this.display.width;
  }
  get height(): number {
    return this.display.height;
  }

  /** Fill the whole display (defaults to clearing to the light ground). */
  clear(on = false): void {
    this.display.clear(on);
  }

  pixel(x: number, y: number, on = true): void {
    this.display.setPixel(Math.round(x), Math.round(y), on);
  }

  get(x: number, y: number): boolean {
    return this.display.getPixel(Math.round(x), Math.round(y));
  }

  hline(x: number, y: number, w: number, on = true): void {
    this.display.fillRect(Math.round(x), Math.round(y), Math.round(w), 1, on);
  }

  vline(x: number, y: number, h: number, on = true): void {
    this.display.fillRect(Math.round(x), Math.round(y), 1, Math.round(h), on);
  }

  /** Outlined rectangle. */
  rect(x: number, y: number, w: number, h: number, on = true): void {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    if (w <= 0 || h <= 0) return;
    this.hline(x, y, w, on);
    this.hline(x, y + h - 1, w, on);
    this.vline(x, y, h, on);
    this.vline(x + w - 1, y, h, on);
  }

  /** Filled rectangle. */
  rectFill(x: number, y: number, w: number, h: number, on = true): void {
    this.display.fillRect(
      Math.round(x),
      Math.round(y),
      Math.round(w),
      Math.round(h),
      on,
    );
  }

  /** Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, on = true): void {
    // Guard against non-finite endpoints (the loop below would never end).
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1))
      return;
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.display.setPixel(x0, y0, on);
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
  circle(cx: number, cy: number, r: number, on = true): void {
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(r)) return;
    cx = Math.round(cx);
    cy = Math.round(cy);
    r = Math.round(r);
    if (r < 0) return;
    let x = r;
    let y = 0;
    let err = 1 - r;
    while (x >= y) {
      this.eightfold(cx, cy, x, y, on);
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
  circleFill(cx: number, cy: number, r: number, on = true): void {
    if (!isFinite(cx) || !isFinite(cy) || !isFinite(r)) return;
    cx = Math.round(cx);
    cy = Math.round(cy);
    r = Math.round(r);
    if (r < 0) return;
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      this.hline(cx - dx, cy + dy, dx * 2 + 1, on);
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

  /** Draw one glyph; returns the x advance. Unknown glyphs render as a box. */
  drawChar(ch: string, x: number, y: number, on = true): number {
    x = Math.round(x);
    y = Math.round(y);
    const glyph = FONT_5X7[ch] ?? FONT_5X7["�"];
    if (glyph) {
      for (let row = 0; row < glyph.length; row++) {
        const line = glyph[row];
        for (let col = 0; col < line.length; col++) {
          if (line[col] !== " " && line[col] !== ".") {
            this.display.setPixel(x + col, y + row, on);
          }
        }
      }
    }
    return GLYPH_ADVANCE;
  }

  /**
   * Draw text starting at (x, y). Handles "\n". Returns the cursor position
   * after the last character.
   */
  print(
    text: string,
    x: number,
    y: number,
    on = true,
  ): { x: number; y: number } {
    const startX = Math.round(x);
    let cx = startX;
    let cy = Math.round(y);
    for (const ch of text) {
      if (ch === "\n") {
        cx = startX;
        cy += LINE_HEIGHT;
        continue;
      }
      this.drawChar(ch, cx, cy, on);
      cx += GLYPH_ADVANCE;
    }
    return { x: cx, y: cy };
  }

  /** Pixel width of a single line of text (no newline handling). */
  textWidth(text: string): number {
    return text.length * GLYPH_ADVANCE;
  }

  private eightfold(
    cx: number,
    cy: number,
    x: number,
    y: number,
    on: boolean,
  ): void {
    const d = this.display;
    d.setPixel(cx + x, cy + y, on);
    d.setPixel(cx + y, cy + x, on);
    d.setPixel(cx - x, cy + y, on);
    d.setPixel(cx - y, cy + x, on);
    d.setPixel(cx - x, cy - y, on);
    d.setPixel(cx - y, cy - x, on);
    d.setPixel(cx + x, cy - y, on);
    d.setPixel(cx + y, cy - x, on);
  }
}

export { GLYPH_WIDTH, GLYPH_HEIGHT, GLYPH_ADVANCE, LINE_HEIGHT };
