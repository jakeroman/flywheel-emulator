/**
 * Sharp Memory LCD abstraction.
 *
 * The real Flywheel uses a 400x240 reflective monochrome Sharp memory display
 * (e.g. LS027B7DH01-class). Two properties of that panel shape this API:
 *
 *  1. It is bistable: once a pixel is set it holds its state with no power and
 *     no redraw. There is no "frame" being continuously scanned out — the
 *     framebuffer simply persists until something writes over it.
 *  2. It updates by line. You can push individual rows (or rectangular
 *     regions) without disturbing the rest of the image. We model this with
 *     dirty-row tracking so a renderer (or, later, a faithful timing model)
 *     can repaint only what changed.
 *
 * On = a dark pixel (ink). Off = the light reflective ground. This matches the
 * mental model of drawing dark shapes onto a pale surface.
 */

export const DISPLAY_WIDTH = 400;
export const DISPLAY_HEIGHT = 240;

/** A 1-bit-per-pixel bitmap that can be blitted onto the framebuffer. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /**
   * Row-major, one byte per pixel (0 = off/light, non-zero = on/dark).
   * One byte per pixel keeps blit logic simple; packing happens only inside
   * the framebuffer itself.
   */
  readonly data: Uint8Array;
}

/** Inclusive-exclusive row span describing what changed since the last flush. */
export interface DirtyRows {
  /** First changed row (inclusive). */
  readonly top: number;
  /** One past the last changed row (exclusive). */
  readonly bottom: number;
}

export interface BlitOptions {
  /** Treat off-pixels in the source as transparent rather than clearing. */
  readonly transparent?: boolean;
  /** Invert the source (on<->off) while blitting. */
  readonly invert?: boolean;
}

/**
 * The drawing surface. Concrete pixel storage lives here (see FrameBuffer);
 * the BIOS and Lua talk to this interface, never to a canvas.
 */
export interface DisplayDevice {
  readonly width: number;
  readonly height: number;

  /** Set a single pixel. Out-of-bounds writes are ignored (like the hardware). */
  setPixel(x: number, y: number, on: boolean): void;
  /** Read a single pixel. Out-of-bounds reads return false. */
  getPixel(x: number, y: number): boolean;

  /** Fill the entire display. Defaults to clearing to the light ground. */
  clear(on?: boolean): void;
  /** Fill an axis-aligned rectangle. */
  fillRect(x: number, y: number, w: number, h: number, on: boolean): void;

  /** Copy a 1bpp bitmap onto the framebuffer at (x, y). */
  blit(bitmap: Bitmap, x: number, y: number, options?: BlitOptions): void;

  /**
   * Monotonic counter bumped on every mutation. A renderer can compare this
   * against its last-seen value to know whether a repaint is needed at all —
   * the cheap stand-in for "the panel holds its image".
   */
  readonly revision: number;

  /** Raw packed framebuffer: 1 bit per pixel, MSB-first, row-major. */
  getPackedBuffer(): Uint8Array;

  /**
   * Returns the rows touched since the last call and resets the dirty range.
   * Null means nothing changed. This is the partial-update hook a faithful
   * line-transfer timing model will eventually drive.
   */
  takeDirtyRows(): DirtyRows | null;
}
