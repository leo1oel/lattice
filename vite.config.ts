import { cpSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * `@pierre/diffs` and `comark` both import the full `shiki` bundle, whose
 * bundledLanguages/bundledThemes maps dynamically import every grammar and
 * theme shiki ships — ~450 chunks, ~13 MB of the built app. At runtime only a
 * closed set is ever loadable: the diff surfaces clamp to tex/bibtex/markdown
 * (see pierreLanguageForPath in src/file-diff-view.tsx) and comark's highlight
 * plugin registers a fixed nine-language set. Everything outside that set is
 * replaced with an inert stub grammar/theme so the chunks shrink to ~100 bytes.
 */
function shikiTrimPlugin(): Plugin {
  const keepLangs = new Set([
    // Registered for Pierre diff views in src/file-diff-view.tsx.
    "tex",
    "bibtex",
    "markdown",
    // comark/dist/plugins/highlight.js registerDefaults().
    "vue",
    "tsx",
    "svelte",
    "typescript",
    "javascript",
    "bash",
    "json",
    "yaml",
    "astro",
  ]);
  const keepThemes = new Set([
    // Pierre themes (src/file-diff-view.tsx).
    "github-light",
    "github-dark",
    // comark defaults.
    "material-theme-lighter",
    "material-theme-palenight",
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

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    // React Compiler auto-memoizes components it can prove safe, and silently
    // skips the rest (e.g. anything the react-hooks lint still flags), so it is
    // safe to enable across the app before every warning is cleaned up.
    react({ babel: { plugins: [["babel-plugin-react-compiler", { target: "19" }]] } }),
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
    rollupOptions: {
      input: {
        app: path.resolve("index.html"),
        "icon-lab": path.resolve("icon-lab.html"),
      },
      output: {
        manualChunks(id) {
          // Stubbed shiki grammars/themes are ~100 bytes each; folding them
          // into one chunk avoids emitting ~450 near-empty asset files.
          if (shikiTrim.isStubbed(id)) return "shiki-stubs";
          if (id.includes("node_modules/@lezer")) return "parser";
          if (id.includes("/node_modules/@codemirror/lang-markdown/") || id.includes("/node_modules/@codemirror/language-data/")) return undefined;
          if (id.includes("/node_modules/@replit/codemirror-vim/") || id.includes("/node_modules/@replit/codemirror-emacs/")) return undefined;
          if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/@uiw/react-codemirror/") || id.includes("/node_modules/codemirror-lang-latex/")) return "editor";
          if (id.includes("pdfjs-dist")) return "pdf-reader";
          if (id.includes("gsap")) return "motion";
          // Match react/react-dom exactly: the loose prefix also caught
          // react-joyride, react-medium-image-zoom, etc., forcing them into
          // the eager ui chunk.
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/") || id.includes("node_modules/lucide-react")) return "ui";
          return undefined;
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
