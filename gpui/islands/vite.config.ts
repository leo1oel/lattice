/**
 * The GPUI app's island pages (`gpui/README.md`, "Webview islands"): the
 * spreadsheet, the board and the Open Slide workspace, each a page built
 * from the Tauri app's own modules in `src/`, compiled the way the app
 * compiles them (React Compiler, Lingui, Tailwind, the private faces), into
 * `gpui/islands/dist/`, which the GPUI app serves under its island protocol
 * (`lattice://island/bundle/<island>/index.html`).
 *
 *   node gpui/script/build-islands     (pnpm exec vite build --config gpui/islands/vite.config.ts)
 *
 * The pages call no Tauri API of their own: each installs a stand-in for
 * Tauri's internals first (`shared/tauri-internals.ts`) that sends every
 * `invoke` to its owner in the GPUI app over the island bridge.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { privateFontsPlugin } from "../../scripts/private-fonts.ts";
import { reactCompilerSuppressionRules } from "../../scripts/react-compiler-suppressions.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const ISLANDS = ["sheet", "board", "slides"] as const;

export default defineConfig({
  root: here,
  // The app's `.env` files (the tldraw licence key) stay where the app reads them.
  envDir: repo,
  publicDir: false,
  // Relative URLs: a page is served at `bundle/<island>/index.html`, its
  // chunks at `bundle/assets/…`.
  base: "./",
  define: {
    "import.meta.env.LATTICE_FLAVOR": JSON.stringify(""),
    "import.meta.env.LATTICE_WEB_DEMO": JSON.stringify(false),
  },
  plugins: [
    react(),
    lingui(),
    // As the app's config: Lingui's macros expand before the compiler runs.
    babel({
      presets: [
        reactCompilerPreset({ target: "19", eslintSuppressionRules: reactCompilerSuppressionRules }),
        linguiTransformerBabelPreset(),
      ],
    }),
    tailwindcss(),
    privateFontsPlugin(),
  ],
  resolve: {
    alias: {
      "@": path.join(repo, "src"),
    },
  },
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    // WKWebView on the macOS 14 minimum has module preload natively.
    modulePreload: { polyfill: false },
    // Univer and tldraw are large, and served from disk: no budget to warn on.
    chunkSizeWarningLimit: 16_384,
    rolldownOptions: {
      input: Object.fromEntries(ISLANDS.map((name) => [name, path.join(here, name, "index.html")])),
    },
  },
});
