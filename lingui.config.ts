import { defineConfig } from "@lingui/cli";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN"],
  catalogs: [{
    path: "src/locales/{locale}/messages",
    include: ["src"],
    exclude: [
      "src/**/*.test.{ts,tsx}",
      "src/test-setup.ts",
      "src/icon-lab/**",
      "src/open-knowledge-app/**",
      "src/open-knowledge-core/**",
    ],
  }],
});
