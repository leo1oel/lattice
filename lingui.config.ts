import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN"],
  // Keep the source reference but drop its line number. `i18n:check` gates on
  // `git diff --exit-code -- src/locales`, and with line numbers every edit
  // that shifts a line rewrites the catalogs, so unrelated work could only pass
  // the gate by committing catalog churn.
  format: formatter({ lineNumbers: false }),
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
