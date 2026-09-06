import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.literature.jsonc" },
    miniflare: {
      bindings: {
        OPENALEX_API_KEYS: "[\"oa-test-secret\"]",
        SEMANTIC_SCHOLAR_API_KEY: "s2-test-secret",
        CROSSREF_EMAIL: "tests@example.com",
        SEMANTIC_SCHOLAR_DAILY_QUOTA: "3",
      },
    },
  })],
  test: {
    include: ["test/literature-worker.test.ts"],
    pool: "cloudflare",
  },
});
