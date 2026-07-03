import { describe, expect, it } from "vitest";
import { FrameBuffer } from "../device/frame-buffer.js";
import { Graphics, GLYPH_ADVANCE, LINE_HEIGHT } from "./graphics.js";

function gfx(w = 64, h = 64): { g: Graphics; fb: FrameBuffer } {
  const fb = new FrameBuffer(w, h);
  return { g: new Graphics(fb), fb };
}

describe("Graphics", () => {
  it("sets and reads pixels", () => {
    const { g } = gfx();
    g.pixel(3, 5, true);
    expect(g.get(3, 5)).toBe(true);
    expect(g.get(4, 5)).toBe(false);
  });

  it("draws a horizontal line across all points", () => {
    const { g } = gfx();
    g.line(2, 10, 8, 10);
    for (let x = 2; x <= 8; x++) expect(g.get(x, 10)).toBe(true);
  });

  it("draws a rectangle outline but not its interior", () => {
    const { g } = gfx();
    g.rect(4, 4, 6, 5);
    expect(g.get(4, 4)).toBe(true); // corner
    expect(g.get(9, 8)).toBe(true); // opposite corner
    expect(g.get(6, 6)).toBe(false); // interior
  });

  it("fills a rectangle", () => {
    const { g } = gfx();
    g.rectFill(4, 4, 6, 5);
    expect(g.get(6, 6)).toBe(true);
  });

  it("draws circle points on the cardinal axes", () => {
    const { g } = gfx();
    g.circle(20, 20, 8);
    expect(g.get(28, 20)).toBe(true);
    expect(g.get(12, 20)).toBe(true);
    expect(g.get(20, 28)).toBe(true);
    expect(g.get(20, 12)).toBe(true);
    expect(g.get(20, 20)).toBe(false); // outline only
  });

  it("fills a circle through the center", () => {
    const { g } = gfx();
    g.circleFill(20, 20, 6);
    expect(g.get(20, 20)).toBe(true);
    expect(g.get(20, 14)).toBe(true);
  });

  it("prints text, advancing the cursor and wrapping on newline", () => {
    const { g } = gfx(128, 64);
    const end = g.print("AB", 0, 0);
    expect(end.x).toBe(2 * GLYPH_ADVANCE);
    // 'A' painted some ink in its cell.
    let inkInA = false;
    for (let y = 0; y < 7 && !inkInA; y++) {
      for (let x = 0; x < 5; x++) if (g.get(x, y)) inkInA = true;
    }
    expect(inkInA).toBe(true);

    const multiline = g.print("X\nY", 0, 0);
    expect(multiline.y).toBe(LINE_HEIGHT);
  });

  it("shades a fill with the ordered 4x4 Bayer pattern", () => {
    const { g } = gfx();
    const countInk = (x0: number, y0: number, w: number, h: number): number => {
      let c = 0;
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) if (g.get(x, y)) c++;
      return c;
    };

    // fill 1 = solid dark; fill 0 = solid light.
    g.rectFill(0, 0, 4, 4, 1);
    expect(countInk(0, 0, 4, 4)).toBe(16);
    g.clear(0);
    g.rectFill(0, 0, 4, 4, 0);
    expect(countInk(0, 0, 4, 4)).toBe(0);

    // fill 0.5 inks exactly half of each 4x4 tile (thresholds 0..7 of 0..15).
    g.clear(0);
    g.rectFill(0, 0, 4, 4, 0.5);
    expect(countInk(0, 0, 4, 4)).toBe(8);
    // Bayer[0][0]=0 (inked, 8 > 0), Bayer[0][1]=8 (not, 8 > 8 is false).
    expect(g.get(0, 0)).toBe(true);
    expect(g.get(1, 0)).toBe(false);

    // fill 0.75 inks 12 of 16 (thresholds 0..11).
    g.clear(0);
    g.rectFill(0, 0, 4, 4, 0.75);
    expect(countInk(0, 0, 4, 4)).toBe(12);

    // The pattern tiles every 4 px.
    g.clear(0);
    g.rectFill(0, 0, 8, 8, 0.5);
    expect(countInk(0, 0, 4, 4)).toBe(8);
    expect(countInk(4, 4, 4, 4)).toBe(8);
  });

  it("shades cls across the whole screen", () => {
    const { g } = gfx(8, 8);
    g.clear(0.25); // 4 of every 16 pixels inked (thresholds 0..3)
    let c = 0;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) if (g.get(x, y)) c++;
    expect(c).toBe((64 / 16) * 4); // 4 tiles × 4 inked
  });

  it("is pixel-identical to the reference fill*16 > bayer for every fill", () => {
    // The integer-threshold hot loop must reproduce the float reference exactly.
    // Sweep 257 fills (incl. non-multiples of 1/16, where truncation would drift)
    // over a tile larger than 4x4 and compare every pixel to fill*16 > bayer.
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const { g } = gfx(8, 8);
    for (let k = 0; k <= 256; k++) {
      const fill = k / 256;
      g.rectFill(0, 0, 8, 8, fill);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const ref = fill * 16 > BAYER[(y & 3) * 4 + (x & 3)];
          expect(g.get(x, y), `fill=${fill} at (${x},${y})`).toBe(ref);
        }
      }
    }
  });

  it("accepts booleans as fill 1/0 (back-compat with the old on flag)", () => {
    const { g } = gfx();
    g.rectFill(0, 0, 4, 4, true); // true = solid dark
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) expect(g.get(x, y)).toBe(true);
    g.rectFill(0, 0, 4, 4, false); // false = solid light
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) expect(g.get(x, y)).toBe(false);
  });

  it("offscreen culling is pixel-identical for huge / off-center circles", () => {
    // Clipping the scan must not change any on-screen pixel. Compare every
    // visible pixel to a brute-force reference (inside-circle AND Bayer-ink).
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const ref = (
      x: number,
      y: number,
      cx: number,
      cy: number,
      r: number,
      fill: number,
    ): boolean => {
      const dy = y - cy;
      if (Math.abs(dy) > r) return false; // outside vertically
      if (Math.abs(x - cx) > Math.floor(Math.sqrt(r * r - dy * dy)))
        return false;
      return BAYER[(y & 3) * 4 + (x & 3)] < Math.ceil(fill * 16);
    };
    const cases: Array<[number, number, number, number]> = [
      [12, 12, 8, 0.5], // on-screen dithered
      [12, 12, 8, 1], // on-screen solid
      [12, 12, 8, 0], // on-screen empty
      [12, 12, 2000, 0.5], // huge, center on-screen (all pixels inside)
      [-1000, 12, 2000, 0.5], // center far off the left
      [12, -1000, 2000, 0.5], // center far off the top
      [30, 30, 10, 0.5], // straddles the bottom-right corner
      [100, 100, 5, 0.5], // entirely off-screen
    ];
    for (const [cx, cy, r, fill] of cases) {
      const { g } = gfx(24, 24);
      g.clear(0);
      g.circleFill(cx, cy, r, fill);
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 24; x++) {
          expect(
            g.get(x, y),
            `circleFill(${cx},${cy},${r},${fill})@(${x},${y})`,
          ).toBe(ref(x, y, cx, cy, r, fill));
        }
      }
    }
  });

  it("does bounded per-pixel work regardless of shape size", () => {
    // A setPixel-counting framebuffer proves the dither loop is O(on-screen),
    // not O(shape). Without culling, a radius-5000 circle would touch ~10^8 px.
    class CountingFrameBuffer extends FrameBuffer {
      calls = 0;
      override setPixel(x: number, y: number, on: boolean): void {
        this.calls++;
        super.setPixel(x, y, on);
      }
    }
    const MAX = 24 * 24; // can't exceed the number of on-screen pixels

    const huge = new CountingFrameBuffer(24, 24);
    const g1 = new Graphics(huge);
    g1.clear(0);
    g1.circleFill(12, 12, 5000, 0.5); // center on-screen, radius ≫ display
    expect(huge.calls).toBeLessThanOrEqual(MAX);

    const off = new CountingFrameBuffer(24, 24);
    const g2 = new Graphics(off);
    g2.circleFill(100000, 100000, 5000, 0.5); // fully off-screen
    expect(off.calls).toBe(0);

    const rectHuge = new CountingFrameBuffer(24, 24);
    const g3 = new Graphics(rectHuge);
    g3.rectFill(-5000, -5000, 10000, 10000, 0.5); // dithered, far bigger than screen
    expect(rectHuge.calls).toBeLessThanOrEqual(MAX);

    // circle() outline: a huge circle centered on screen has no visible outline.
    const ring = new CountingFrameBuffer(24, 24);
    new Graphics(ring).circle(12, 12, 5000, 1);
    expect(ring.calls).toBe(0);

    // line() fully off-screen does no work.
    const seg = new CountingFrameBuffer(24, 24);
    new Graphics(seg).line(-5000, -5000, -6000, -6000, 1);
    expect(seg.calls).toBe(0);
  });

  it("draws nothing for a NaN width/height (fail-closed clip)", () => {
    const { g } = gfx(12, 12);
    g.clear(0);
    g.rectFill(2, 2, NaN, 5, 0.5); // dither path
    g.rectFill(2, 2, 6, NaN, 1); // solid path
    g.hline(3, 4, NaN, 0.5);
    let c = 0;
    for (let y = 0; y < 12; y++)
      for (let x = 0; x < 12; x++) if (g.get(x, y)) c++;
    expect(c).toBe(0);
  });

  it("still draws a partially visible huge circle outline (no over-reject)", () => {
    // Center far above the screen, but the bottom of the ring dips onto it at
    // (12,12): the annulus reject must NOT skip this — a real arc is visible.
    const { g } = gfx(24, 24);
    g.circle(12, -4988, 5000, 1);
    let any = false;
    for (let y = 0; y < 24 && !any; y++)
      for (let x = 0; x < 24; x++) if (g.get(x, y)) any = true;
    expect(any).toBe(true);
  });

  it("measures text width by advance", () => {
    const { g } = gfx();
    expect(g.textWidth("12345")).toBe(5 * GLYPH_ADVANCE);
  });

  it("scales text by an integer factor", () => {
    const { g } = gfx(128, 64);
    // Width + advance + line height all scale linearly.
    expect(g.textWidth("HELLO", 2)).toBe(g.textWidth("HELLO") * 2);
    expect(g.print("AB", 0, 0, true, 2).x).toBe(2 * GLYPH_ADVANCE * 2);
    expect(g.print("X\nY", 0, 0, true, 2).y).toBe(LINE_HEIGHT * 2);

    // Each font pixel becomes a 2x2 block → exactly 4x the ink of the 1x glyph.
    const ink = (): number => {
      let c = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 128; x++) if (g.get(x, y)) c++;
      return c;
    };
    g.clear(false);
    g.print("A", 0, 0, true, 1);
    const c1 = ink();
    g.clear(false);
    g.print("A", 0, 0, true, 2);
    expect(c1).toBeGreaterThan(0);
    expect(ink()).toBe(c1 * 4);

    // Scale clamps to a positive integer (floor; minimum 1).
    expect(g.textWidth("A", 0)).toBe(g.textWidth("A", 1));
    expect(g.textWidth("A", 2.9)).toBe(g.textWidth("A", 2));
  });
});
