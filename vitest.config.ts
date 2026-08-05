import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Keep the `@/…` alias in sync with vite.config.ts / tsconfig so tests can
    // import shadcn/ui components the same way the app does.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Vendored Open Knowledge app layer (see scripts/vendor-open-knowledge.mjs).
      "@ok-app": fileURLToPath(new URL("./src/open-knowledge-app", import.meta.url)),
      "@ok-core": fileURLToPath(new URL("./src/open-knowledge-core/index.ts", import.meta.url)),
    },
  },
  test: {
    // collab-server has its own vitest config using the Cloudflare Workers
    // pool; its tests cannot run under this runner (`cloudflare:` imports).
    exclude: ["**/node_modules/**", "collab-server/**"],
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Room for the slowest test to finish on a loaded machine rather than a
    // quiet one; the per-assertion wait is set alongside it in test-setup.ts.
    testTimeout: 20_000,
  },
});
