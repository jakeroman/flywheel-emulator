import { describe, expect, it } from "vitest";
import { FrameBuffer } from "./frame-buffer.js";

describe("FrameBuffer", () => {
  it("sets and reads pixels", () => {
    const fb = new FrameBuffer(16, 8);
    expect(fb.getPixel(3, 4)).toBe(false);
    fb.setPixel(3, 4, true);
    expect(fb.getPixel(3, 4)).toBe(true);
    fb.setPixel(3, 4, false);
    expect(fb.getPixel(3, 4)).toBe(false);
  });

  it("ignores out-of-bounds access", () => {
    const fb = new FrameBuffer(16, 8);
    expect(() => fb.setPixel(-1, 0, true)).not.toThrow();
    expect(() => fb.setPixel(100, 100, true)).not.toThrow();
    expect(fb.getPixel(-1, 0)).toBe(false);
    expect(fb.getPixel(999, 999)).toBe(false);
  });

  it("packs MSB-first, row-major", () => {
    const fb = new FrameBuffer(16, 2);
    fb.setPixel(0, 0, true); // top bit of byte 0
    fb.setPixel(7, 1, true); // bottom bit of byte 0 of row 1
    const buf = fb.getPackedBuffer();
    expect(buf[0]).toBe(0x80);
    expect(buf[2]).toBe(0x01); // row 1 starts at byte index width/8 = 2
  });

  it("only ticks revision on a real change", () => {
    const fb = new FrameBuffer(16, 8);
    expect(fb.revision).toBe(0);
    fb.clear(false); // already clear — no-op
    expect(fb.revision).toBe(0);
    fb.setPixel(1, 1, true);
    expect(fb.revision).toBe(1);
    fb.fillRect(8, 0, 4, 4, false); // those pixels already off — no-op
    expect(fb.revision).toBe(1);
    fb.fillRect(8, 0, 4, 4, true); // real change
    expect(fb.revision).toBe(2);
  });

  it("tracks and resets dirty rows", () => {
    const fb = new FrameBuffer(16, 8);
    fb.setPixel(2, 3, true);
    expect(fb.takeDirtyRows()).toEqual({ top: 3, bottom: 4 });
    expect(fb.takeDirtyRows()).toBeNull(); // reset after taking
  });

  it("blits with clipping, transparency, and inversion", () => {
    const fb = new FrameBuffer(8, 8);
    const bitmap = {
      width: 2,
      height: 2,
      data: new Uint8Array([1, 0, 0, 1]),
    };
    fb.blit(bitmap, 0, 0);
    expect(fb.getPixel(0, 0)).toBe(true);
    expect(fb.getPixel(1, 0)).toBe(false);

    fb.clear(false);
    fb.setPixel(1, 0, true);
    fb.blit(bitmap, 0, 0, { transparent: true });
    expect(fb.getPixel(1, 0)).toBe(true); // off source pixel left untouched

    fb.clear(false);
    fb.blit(bitmap, 0, 0, { invert: true });
    expect(fb.getPixel(0, 0)).toBe(false);
    expect(fb.getPixel(1, 0)).toBe(true);

    // Negative offset clips without throwing.
    expect(() => fb.blit(bitmap, -1, -1)).not.toThrow();
  });
});
