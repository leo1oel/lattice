import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.literature.jsonc" },
    miniflare: {
      bindings: {
        OPENALEX_API_KEYS: "[\"oa-test-secret-a\",\"oa-test-secret-b\"]",
        // Simulate stale deployed bindings: they must never enable public S2.
        SEMANTIC_SCHOLAR_API_KEYS: "[\"s2-test-secret-a\",\"s2-test-secret-b\"]",
        SEMANTIC_SCHOLAR_API_KEY: "s2-legacy-secret",
        CROSSREF_EMAIL: "tests@example.com",
      },
    },
  })],
  test: {
    include: ["test/literature-worker.test.ts"],
    pool: "cloudflare",
  },
});
