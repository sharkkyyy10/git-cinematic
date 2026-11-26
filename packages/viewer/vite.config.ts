import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1024,
  },
  preview: {
    port: 4180,
    strictPort: true,
  },
});
