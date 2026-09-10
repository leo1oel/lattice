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
    // The dev-only icon playground needs no exclusion: it lives in `tools/`,
    // outside `include`. The production icon components it exercises
    // (src/animated-icons/**) carry no macros, so extraction sees nothing there.
    exclude: [
      "src/**/*.test.{ts,tsx}",
      "src/platform/test-setup.ts",
      // The selection toolbar uses real Lingui macros; the rest of the
      // vendor still uses its English-only runtime shims.
      "src/open-knowledge-app/**/!(BlockTypeSelector|InlineFormatButtons|FootnoteBubbleButton|LinkEditPopover|ViewInSourceBubbleButton|CommentBubbleButton).{ts,tsx}",
      "src/open-knowledge-core/**",
    ],
  }],
});
