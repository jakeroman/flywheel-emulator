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
