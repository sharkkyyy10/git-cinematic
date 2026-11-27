import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Use the shared decoder from source, so the viewer does not depend on a prior core build.
    alias: {
      "@git-cinematic/core/format": fileURLToPath(new URL("../core/src/format.ts", import.meta.url)),
      "@git-cinematic/core/insights": fileURLToPath(new URL("../core/src/insights.ts", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1024,
  },
  preview: {
    port: 4180,
    strictPort: true,
  },
});
