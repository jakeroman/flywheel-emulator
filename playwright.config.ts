import { defineConfig } from "@playwright/test";

/**
 * End-to-end smoke tests that drive the real app in a browser. These complement
 * the Vitest unit tests (which cover the pure-TS core) by verifying the parts
 * that only exist in the browser — wasmoon loading, the canvas, and the full
 * Lua run loop. The dev server is started automatically.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: {
    baseURL: "http://localhost:4173",
    browserName: "chromium",
  },
  // Test the production build (preview) so the bundled wasm asset and any
  // code-splitting are exercised — the dev server wouldn't catch those.
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
