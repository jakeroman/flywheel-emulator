import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The emulator-core HAL is pure TypeScript with no DOM dependency.
    environment: "node",
    include: ["packages/**/src/**/*.test.ts"],
  },
});
