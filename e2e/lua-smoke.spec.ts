import { expect, test } from "@playwright/test";

const inkRatio = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128) dark++;
    return dark / (canvas.width * canvas.height);
  });

async function run(page: import("@playwright/test").Page, path: string) {
  await expect(
    page.locator(`.fw-lua__select option[value="${path}"]`),
  ).toHaveCount(1, { timeout: 15_000 });
  await page.selectOption(".fw-lua__select", path);
  await page.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".fw-lua__badge")).toHaveText("running", {
    timeout: 15_000,
  });
  await expect(page.locator(".fw-lua__error")).toHaveCount(0);
}

/**
 * Phase 1 deliverable check: Lua apps load from the SD card and run in the
 * browser, drawing to the display with no errors. Exercises wasmoon loading the
 * local wasm, the `fw` API bridge, the host run loop, and switching games.
 */
test("runs and switches between seeded Lua games", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await expect(page.locator(".fw-device")).toBeVisible();

  // First game: the bouncing-ball demo.
  await run(page, "/games/demo/main.lua");
  await expect(page.locator(".fw-lua__console")).toContainText(
    "demo started: 400x240",
  );
  await expect.poll(() => inkRatio(page), { timeout: 5_000 }).toBeGreaterThan(0);

  // Switching to a second game loads and draws it (not a frozen first frame).
  await run(page, "/games/snake/main.lua");
  await expect.poll(() => inkRatio(page), { timeout: 5_000 }).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});
