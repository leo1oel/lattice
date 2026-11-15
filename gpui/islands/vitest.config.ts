/**
 * Unit tests for the island pages' own modules (`gpui/islands/**`), which the
 * repository's `vitest.config.ts` leaves out with the rest of `gpui/`:
 *
 *   pnpm vitest run --config gpui/islands/vitest.config.ts
 *
 * They test plain modules, so they run in Node without the app's transforms.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**"],
    environment: "node",
  },
});
