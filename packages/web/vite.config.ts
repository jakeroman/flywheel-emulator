import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume the core as TypeScript source so Vite transpiles it directly —
    // no build step for the workspace package during development. The second
    // entry keeps export subpaths (e.g. "@flywheel/emulator-core/hal")
    // resolving to source consistently with the bare specifier.
    alias: [
      {
        find: /^@flywheel\/emulator-core$/,
        replacement: resolve(here, "../emulator-core/src/index.ts"),
      },
      {
        find: /^@flywheel\/emulator-core\/(.*)$/,
        replacement: resolve(here, "../emulator-core/src/$1"),
      },
    ],
  },
  server: {
    // Pin the port: the emulator's SD card (games, saves) lives in the browser's
    // IndexedDB, which is keyed by origin *including the port*. A stable port
    // keeps that store — and your games — in one place. strictPort makes startup
    // fail loudly if 3002 is taken rather than silently switching ports (which
    // would point the browser at a different, empty IndexedDB).
    port: 3002,
    strictPort: true,
    fs: {
      // Allow serving TS source from sibling workspace packages.
      allow: [resolve(here, "..", "..")],
    },
  },
});
