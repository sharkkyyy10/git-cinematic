import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run before the build, so point workspace imports at the sources.
    alias: [
      {
        find: /^@git-cinematic\/core\/format$/,
        replacement: fileURLToPath(new URL("./packages/core/src/format.ts", import.meta.url)),
      },
      {
        find: /^@git-cinematic\/core\/insights$/,
        replacement: fileURLToPath(new URL("./packages/core/src/insights.ts", import.meta.url)),
      },
      {
        find: /^@git-cinematic\/core$/,
        replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
