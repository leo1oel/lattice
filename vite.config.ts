import { cpSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import stylex from "@stylexjs/unplugin";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

/**
 * `@pierre/diffs` imports the full `shiki` bundle, whose bundledLanguages and
 * bundledThemes maps dynamically import every grammar and theme shiki ships —
 * ~450 chunks, ~13 MB of the built app. At runtime only a closed set is ever
 * loadable: src/history/file-diff-view.tsx is the only module that calls
 * registerCustomLanguage/registerCustomTheme, and its pierreLanguageForPath
 * clamps every filetype outside tex/bibtex/markdown to "text". Everything
 * outside that set is replaced with an inert stub grammar/theme so the chunks
 * shrink to ~100 bytes.
 *
 * If new code can highlight more languages at runtime, extend keepLangs below —
 * a missing grammar degrades silently to unhighlighted text rather than
 * throwing, so this will not fail a test.
 */
function shikiTrimPlugin(): {
  plugin: Plugin;
  isStubbed: (id: string) => boolean;
} {
  const keepLangs = new Set([
    // The only grammars any runtime path can reach. src/history/file-diff-view.tsx is
    // the sole caller of registerCustomLanguage, and pierreLanguageForPath
    // clamps every other filetype to "text", which needs no grammar.
    "tex",
    "bibtex",
    "markdown",
  ]);
  const keepThemes = new Set([
    // Pierre themes (src/history/file-diff-view.tsx), the sole caller of
    // registerCustomTheme.
    "github-light",
    "github-dark",
  ]);
  // The package only exports grammar subpaths, so locate dist/ via one of them.
  const langsDist = path.dirname(
    fileURLToPath(import.meta.resolve("@shikijs/langs/markdown")),
  );
  // Kept grammars statically import the grammars they embed (vue pulls html,
  // css, …), so keep the transitive closure or embedded regions lose their
  // rules.
  const queue = [...keepLangs];
  while (queue.length > 0) {
    const name = queue.pop()!;
    let source = "";
    try {
      source = readFileSync(path.join(langsDist, `${name}.mjs`), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/import \w+ from ['"]\.\/([\w.+-]+)\.mjs['"]/g)) {
      if (!keepLangs.has(match[1])) {
        keepLangs.add(match[1]);
        queue.push(match[1]);
      }
    }
  }
  const moduleName = (id: string, kind: "langs" | "themes") => {
    const match = id.match(new RegExp(`@shikijs/${kind}/dist/([\\w.+-]+)\\.mjs$`));
    return match ? match[1] : null;
  };
  const isStubbed = (id: string) => {
    const lang = moduleName(id, "langs");
    if (lang) return !keepLangs.has(lang);
    const theme = moduleName(id, "themes");
    if (theme) return !keepThemes.has(theme);
    return false;
  };
  const plugin: Plugin = {
    name: "shiki-trim",
    apply: "build",
    load(id) {
      const lang = moduleName(id, "langs");
      if (lang && !keepLangs.has(lang)) {
        return `export default [{ name: ${JSON.stringify(lang)}, scopeName: ${JSON.stringify(`source.${lang}`)}, patterns: [] }];`;
      }
      const theme = moduleName(id, "themes");
      if (theme && !keepThemes.has(theme)) {
        return `export default { name: ${JSON.stringify(theme)}, type: "dark", colors: {}, tokenColors: [] };`;
      }
      return null;
    },
  };
  return { plugin, isStubbed };
}

/** Ship pdf.js CMaps + standard fonts next to the web assets (needed offline in Tauri). */
function pdfjsAssetsPlugin(): Plugin {
  const copy = () => {
    const pdfjsRoot = path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
    const outRoot = path.resolve("public/pdfjs");
    mkdirSync(outRoot, { recursive: true });
    cpSync(path.join(pdfjsRoot, "cmaps"), path.join(outRoot, "cmaps"), { recursive: true });
    cpSync(path.join(pdfjsRoot, "standard_fonts"), path.join(outRoot, "standard_fonts"), {
      recursive: true,
    });
  };
  return {
    name: "pdfjs-assets",
    buildStart: copy,
    configureServer() {
      copy();
    },
  };
}

const shikiTrim = shikiTrimPlugin();

const manualChunkName = (id: string) => {
  // Stubbed shiki grammars/themes are ~100 bytes each; folding them into one
  // chunk avoids emitting ~450 near-empty asset files.
  if (shikiTrim.isStubbed(id)) return "shiki-stubs";
  if (id.includes("node_modules/@lezer")) return "parser";
  if (id.includes("/node_modules/@codemirror/lang-markdown/") || id.includes("/node_modules/@codemirror/language-data/")) return undefined;
  if (id.includes("/node_modules/@replit/codemirror-vim/") || id.includes("/node_modules/@replit/codemirror-emacs/")) return undefined;
  if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/@uiw/react-codemirror/") || id.includes("/node_modules/codemirror-lang-latex/")) return "editor";
  if (id.includes("pdfjs-dist")) return "pdf-reader";
  if (id.includes("gsap")) return "motion";
  // Match react/react-dom exactly: the loose prefix also caught react-joyride,
  // react-medium-image-zoom, etc., forcing them into the eager ui chunk.
  if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/") || id.includes("node_modules/lucide-react")) return "ui";
  return undefined;
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [
    // StyleX must transform source before the React plugin to preserve Fast
    // Refresh. CSS layers let it coexist with Tailwind during the PoC; the
    // unplugin appends the extracted atomic rules to the existing CSS asset.
    stylex.vite({ useCSSLayers: true }),
    // React Compiler auto-memoizes components it can prove safe, and silently
    // skips the rest (e.g. anything the react-hooks lint still flags), so it is
    // safe to enable across the app before every warning is cleaned up.
    react(),
    lingui(),
    // Babel applies presets right-to-left: Lingui macros must expand first so
    // the compiler sees ordinary React rather than macro-generated components.
    babel({
      presets: [
        reactCompilerPreset({ target: "19" }),
        linguiTransformerBabelPreset(),
      ],
    }),
    tailwindcss(),
    pdfjsAssetsPlugin(),
    shikiTrim.plugin,
  ],

  resolve: {
    alias: {
      "@": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src"),
      // Vendored Open Knowledge app layer (see scripts/vendor-open-knowledge.mjs).
      "@ok-app": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src/open-knowledge-app"),
      "@ok-core": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src/open-knowledge-core/index.ts"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rolldownOptions: {
      // One entry, on purpose. The animated-icon playground (icon-lab.html →
      // tools/icon-lab) is development-only: the dev server serves any html at
      // the project root, so `pnpm dev` still reaches /icon-lab.html, while the
      // production build never sees it and emits no icon-lab artifact.
      input: {
        app: path.resolve("index.html"),
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name(id) {
                const explicitName = manualChunkName(id);
                if (explicitName) return explicitName;

                // Rolldown's automatic common chunks are split by every lazy
                // entry signature, which shatters startup into many small
                // requests. There is exactly one html entry, so every remaining
                // `$initial` module is reachable from it: naming them all `app`
                // recovers Rollup's coarser startup boundary. (While the icon
                // lab was a second build input, modules shared with it were
                // pulled out into a `provided-icons` chunk; with a single entry
                // that split cannot arise.)
                return "app";
              },
              tags: ["$initial"],
              includeDependenciesRecursively: false,
              priority: 1,
            },
            {
              name: manualChunkName,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // Permit Amp's HTTPS portal host when reviewing isolated development pages.
    allowedHosts: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // `collab-server/.wrangler` is the local sync server's Durable Object
      // state. Every keystroke a peer syncs rewrites those SQLite WAL files, so
      // watching them made Vite full-reload the app mid-session: an in-flight
      // rejoin or share lost its JavaScript before it could finish, and the
      // room appeared to need a second click to actually go live.
      //
      // Matched as regexes rather than globs: a glob is evaluated per path, so
      // events for a directory tree the dev server recreates (wrangler restart)
      // slipped through before the pattern applied to its descendants.
      ignored: [/[\\/]src-tauri[\\/]/, /[\\/]collab-server[\\/]\.wrangler[\\/]/],
    },
  },
}));
