import { expect, test } from "@playwright/test";

/**
 * Phase 1 deliverable check: a Lua app loaded from the SD card runs in the
 * browser and draws to the display, with no errors. This exercises wasmoon
 * loading the local wasm, the `fw` API bridge, and the host run loop.
 */
test("runs a Lua app from the SD card in the browser", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await expect(page.locator(".fw-device")).toBeVisible();

  // The SD card seeds asynchronously from IndexedDB; wait for the demo file.
  await expect(
    page.locator('.fw-lua__select option[value="/games/demo/main.lua"]'),
  ).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption(".fw-lua__select", "/games/demo/main.lua");
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.locator(".fw-lua__badge")).toHaveText("running", {
    timeout: 15_000,
  });
  await expect(page.locator(".fw-lua__error")).toHaveCount(0);
  await expect(page.locator(".fw-lua__console")).toContainText(
    "demo started: 400x240",
  );

  // The script is actively drawing ink to the otherwise-light display.
  const inkRatio = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
    return dark / (canvas.width * canvas.height);
  });
  expect(inkRatio).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
