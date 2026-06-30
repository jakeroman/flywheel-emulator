import { expect, test, type Page } from "@playwright/test";

const inkRatio = (page: Page) =>
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

// The Dev tab's first badge mirrors the BIOS screen (boot/menu/game/…).
const screenBadge = (page: Page) => page.locator(".fw-lua__badge").first();

async function waitForSeed(page: Page) {
  await expect(
    page.locator('.fw-lua__select option[value="/games/snake/main.lua"]'),
  ).toHaveCount(1, { timeout: 15_000 });
}

/**
 * Phase 2 deliverable: powering on boots the BIOS into the game selector, A
 * launches the selected game, and Menu returns to the selector — in a real
 * browser against the production build.
 */
test("boots the BIOS, launches a game, and returns to the menu", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await expect(page.locator(".fw-device")).toBeVisible();
  await waitForSeed(page);
  await page.getByRole("button", { name: "Dev" }).click(); // reveal status badge

  // Power on → boot splash → game selector.
  await page.getByRole("switch", { name: "Power switch" }).click();
  // Move focus off the switch so Enter (Menu) doesn't toggle power.
  await page.locator(".fw-display__bezel").click();
  await expect(screenBadge(page)).toHaveText("menu", { timeout: 10_000 });

  // A launches the selected game.
  await page.keyboard.press("x");
  await expect(screenBadge(page)).toHaveText("game", { timeout: 10_000 });
  await expect.poll(() => inkRatio(page), { timeout: 5_000 }).toBeGreaterThan(0);

  // Menu (Enter) exits back to the selector.
  await page.keyboard.press("Enter");
  await expect(screenBadge(page)).toHaveText("menu", { timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});

/**
 * Phase 3 deliverable: open a file in the in-browser editor and Run it on the
 * device without leaving the page.
 */
test("opens a script in the editor and runs it", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await waitForSeed(page); // editor tab is the default

  await page.getByTitle("/games/demo/main.lua").click();
  await expect(page.locator(".cm-content")).toContainText("FLYWHEEL LUA DEMO");

  await page.getByRole("button", { name: /Run/ }).click();
  await page.getByRole("button", { name: "Dev" }).click();
  await expect(screenBadge(page)).toHaveText("game", { timeout: 10_000 });
  await expect.poll(() => inkRatio(page), { timeout: 5_000 }).toBeGreaterThan(0);

  expect(pageErrors).toEqual([]);
});

test("dev launcher runs a script directly", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("/");
  await waitForSeed(page);
  await page.getByRole("button", { name: "Dev" }).click();

  await page.selectOption(".fw-lua__select", "/games/snake/main.lua");
  await page.getByRole("button", { name: "Launch" }).click();

  await expect(screenBadge(page)).toHaveText("game", { timeout: 10_000 });
  await expect.poll(() => inkRatio(page), { timeout: 5_000 }).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});
