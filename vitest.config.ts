import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";

export default defineConfig({
  // The suite runs the compiled output, the same as the app: vite.config.ts
  // applies this preset pair in this order, and for a long time this file did
  // not, so nothing ever exercised the code that actually ships.
  // `react-compiler-guard.test.ts` counts *bailouts*, which means it watches the
  // files the compiler skips and says nothing about the ones it compiles — a
  // component with zero bailouts was the least-tested code in the repo.
  //
  // It costs about 18% wall clock (transform 15s → 59s, run 64s → 76s). That is
  // the price of testing what ships; do not trade it back.
  //
  // Turning it on exposed two live defects, both of the same shape — state React
  // cannot observe changing, read during render, then memoized away:
  // `AppToast`'s actions came from a module map keyed on an entry id that does
  // not move when the actions are replaced (app-log-store.ts now pairs them into
  // one subscribed snapshot), and `Mirror` subscribed to a revision counter it
  // discarded instead of to the source text it renders (Mirror-host.tsx). Both
  // were intermittent in real use, papered over by incidental re-renders from
  // neighbouring components.
  //
  // Babel applies presets right-to-left: Lingui macros must expand first so the
  // compiler sees ordinary React rather than macro-generated components.
  plugins: [
    lingui(),
    babel({
      presets: [
        reactCompilerPreset({ target: "19" }),
        linguiTransformerBabelPreset(),
      ],
    }),
  ],
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
    //
    // `.tmp/` is the scratch directory for throwaway builds and debug dumps. A
    // checkout staged in there brings its own test suite, and vitest's default
    // glob happily collected hundreds of foreign tests that fail under this
    // config — enough to make `pnpm check` unusable.
    exclude: ["**/node_modules/**", "collab-server/**", ".tmp/**"],
    environment: "jsdom",
    setupFiles: ["./src/platform/test-setup.ts"],
    // Several suites mount the complete app or visual Markdown editor. Running
    // those memory-heavy files beside each other on a high-core machine starves
    // their async UI assertions and makes unrelated tests fail nondeterministically.
    maxWorkers: 1,
    // Room for the slowest test to finish on a loaded machine rather than a
    // quiet one; the per-assertion wait is set alongside it in test-setup.ts.
    testTimeout: 20_000,
  },
});
