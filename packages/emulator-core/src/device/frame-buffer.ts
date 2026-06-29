import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  type Bitmap,
  type BlitOptions,
  type DirtyRows,
  type DisplayDevice,
} from "../hal/display.js";

/**
 * In-memory implementation of the Sharp memory display.
 *
 * Storage is the same packed layout the real panel consumes: 1 bit per pixel,
 * MSB-first within each byte, row-major. A bit value of 1 means "on" (dark
 * ink); 0 means the light reflective ground. Keeping the native packing here
 * means a future line-transfer timing model can stream these bytes directly.
 */
export class FrameBuffer implements DisplayDevice {
  readonly width: number;
  readonly height: number;
  private readonly bytesPerRow: number;
  private readonly buffer: Uint8Array;

  private _revision = 0;
  private dirtyTop = Number.POSITIVE_INFINITY;
  private dirtyBottom = 0;

  constructor(width = DISPLAY_WIDTH, height = DISPLAY_HEIGHT) {
    this.width = width;
    this.height = height;
    this.bytesPerRow = Math.ceil(width / 8);
    this.buffer = new Uint8Array(this.bytesPerRow * height);
  }

  get revision(): number {
    return this._revision;
  }

  setPixel(x: number, y: number, on: boolean): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const byteIndex = y * this.bytesPerRow + (x >> 3);
    const mask = 0x80 >> (x & 7);
    const prev = this.buffer[byteIndex];
    const next = on ? prev | mask : prev & ~mask;
    if (next !== prev) {
      this.buffer[byteIndex] = next;
      this.markDirty(y, y + 1);
    }
  }

  getPixel(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
    const byteIndex = y * this.bytesPerRow + (x >> 3);
    const mask = 0x80 >> (x & 7);
    return (this.buffer[byteIndex] & mask) !== 0;
  }

  clear(on = false): void {
    const value = on ? 0xff : 0x00;
    let changed = false;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.buffer[i] !== value) {
        this.buffer[i] = value;
        changed = true;
      }
    }
    // Only a true mutation should tick the revision, so a redraw of an
    // unchanged screen doesn't force the renderer to repaint.
    if (changed) this.markDirty(0, this.height);
  }

  fillRect(x: number, y: number, w: number, h: number, on: boolean): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    let changed = false;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const byteIndex = py * this.bytesPerRow + (px >> 3);
        const mask = 0x80 >> (px & 7);
        const prev = this.buffer[byteIndex];
        const next = on ? prev | mask : prev & ~mask;
        if (next !== prev) {
          this.buffer[byteIndex] = next;
          changed = true;
        }
      }
    }
    if (changed) this.markDirty(y0, y1);
  }

  blit(bitmap: Bitmap, x: number, y: number, options: BlitOptions = {}): void {
    const { transparent = false, invert = false } = options;
    const x0 = Math.max(0, -x);
    const y0 = Math.max(0, -y);
    const x1 = Math.min(bitmap.width, this.width - x);
    const y1 = Math.min(bitmap.height, this.height - y);
    if (x1 <= x0 || y1 <= y0) return;
    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        let on = bitmap.data[sy * bitmap.width + sx] !== 0;
        if (invert) on = !on;
        if (transparent && !on) continue;
        this.setPixel(x + sx, y + sy, on);
      }
    }
  }

  getPackedBuffer(): Uint8Array {
    return this.buffer;
  }

  takeDirtyRows(): DirtyRows | null {
    if (this.dirtyTop >= this.dirtyBottom) return null;
    const rows: DirtyRows = { top: this.dirtyTop, bottom: this.dirtyBottom };
    this.dirtyTop = Number.POSITIVE_INFINITY;
    this.dirtyBottom = 0;
    return rows;
  }

  private markDirty(top: number, bottom: number): void {
    if (top < this.dirtyTop) this.dirtyTop = top;
    if (bottom > this.dirtyBottom) this.dirtyBottom = bottom;
    this._revision++;
  }
}
