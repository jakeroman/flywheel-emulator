import { Graphics, type DisplayDevice } from "@flywheel/emulator-core";

/**
 * The image shown on the (bistable) display while the device is powered off,
 * before the BIOS boots. A reflective memory LCD holds its last frame with no
 * power, so a real device would show whatever was last drawn — here we present
 * a tidy "slide power on" hint.
 */
export function drawIdleScreen(display: DisplayDevice): void {
  const g = new Graphics(display);
  const W = display.width;
  const H = display.height;
  g.clear();
  g.rect(0, 0, W, H, true);
  center(g, "FLYWHEEL", 96);
  center(g, "slide POWER to ON", 120);
}

function center(g: Graphics, text: string, y: number): void {
  g.print(text, Math.round((g.width - g.textWidth(text)) / 2), y, true);
}
