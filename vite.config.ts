import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, minifySync, type Plugin } from "vite";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { privateFontsPlugin } from "./scripts/private-fonts.ts";
import { reactCompilerSuppressionRules } from "./scripts/react-compiler-suppressions.ts";

const host = process.env.TAURI_DEV_HOST;
// `LATTICE_FLAVOR=beta` builds Lattice Beta (docs/release-process.md), read by
// src-tauri/build.rs too. Any other value is a typo that would silently build
// the release flavor.
const flavor = process.env.LATTICE_FLAVOR ?? "";
if (flavor !== "" && flavor !== "beta") throw new Error(`LATTICE_FLAVOR=${flavor}: the only flavor is "beta"`);

/**
 * `@pierre/diffs` imports the full `shiki` bundle, whose bundledLanguages and
 * bundledThemes maps dynamically import every grammar and theme shiki ships —
 * ~450 chunks, ~13 MB of the built app. At runtime only a closed set is ever
 * loadable: src/history/pierre-diff.ts is the only module that calls
 * registerCustomLanguage/registerCustomTheme, and its pierreLanguageForPath
 * clamps every filetype outside tex/bibtex/markdown to "text". Everything
 * outside that set is replaced with an inert stub grammar/theme so the chunks
 * shrink to ~100 bytes.
 *
 * If new code can highlight more languages at runtime, extend keepLangs below.
 * A missing grammar degrades silently to unhighlighted text rather than
 * throwing, so no test notices; the build fails instead when a module under
 * src/ imports a grammar or theme that is stubbed. Code that reaches one only
 * through shiki's own bundled maps is not caught, which is why the allowlist
 * comments name the one caller.
 */
function shikiTrimPlugin(): {
  plugin: Plugin;
  isStubbed: (id: string) => boolean;
} {
  const keepLangs = new Set([
    // The only grammars any runtime path can reach. src/history/pierre-diff.ts is
    // the sole caller of registerCustomLanguage, and pierreLanguageForPath
    // clamps every other filetype to "text", which needs no grammar.
    "tex",
    "bibtex",
    "markdown",
  ]);
  const keepThemes = new Set([
    // Pierre themes (src/history/pierre-diff.ts), the sole caller of
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
    buildEnd(error) {
      if (error) return;
      const srcRoot = path.resolve("src") + path.sep;
      const offenders = [...this.getModuleIds()].flatMap((id) => {
        if (!isStubbed(id)) return [];
        const importers = this.getModuleInfo(id)?.importers.filter((importer) => importer.startsWith(srcRoot)) ?? [];
        return importers.map((importer) => `${path.relative(".", importer)} imports ${path.basename(id, ".mjs")}`);
      });
      if (offenders.length > 0) {
        this.error(
          `shiki-trim: these imports get an empty stub, so their code would render unhighlighted. Add the name to keepLangs or keepThemes in vite.config.ts:\n  ${offenders.join("\n  ")}`,
        );
      }
    },
  };
  return { plugin, isStubbed };
}

/**
 * Univer's render engine (the spreadsheet editor, src/editor/spreadsheet/)
 * maps 77 hyphenation dictionaries to dynamic imports, ~4.6 MB of chunks, but
 * only asks for a closed set of them: its language detector maps what franc
 * recognises onto 33 dictionaries (LANG_MAP_TO_HYPHEN_LANG), and the
 * hyphenator itself loads en-gb and bundles en-us. The other 45 (~2.7 MB:
 * Norwegian, the 1996 and Swiss German spellings, …) can never be loaded,
 * so their loaders are dropped and their chunks are not emitted.
 *
 * The build fails instead when an upgrade changes how dictionaries are asked
 * for (a new loadPattern caller, a detector that no longer goes through the
 * map), so a dictionary a new path needs is never silently missing.
 */
function univerHyphenTrimPlugin(): Plugin {
  const engine = /\/@univerjs\/engine-render\/lib\/es\/index\.js$/;
  return {
    name: "univer-hyphen-trim",
    apply: "build",
    transform(code, id) {
      if (!engine.test(id)) return null;
      const fail = (why: string): never => this.error(
        `univer-hyphen-trim: ${why}. Check which hyphenation dictionaries @univerjs/engine-render can load now, and update univerHyphenTrimPlugin in vite.config.ts.`,
      );
      const loaders = /^const PATTERN_LOADERS = \{\n([\s\S]*?)\n\};$/m.exec(code) ?? fail("PATTERN_LOADERS is gone");
      const detector = /^const LANG_MAP_TO_HYPHEN_LANG = \{\n([\s\S]*?)\n\};$/m.exec(code) ?? fail("LANG_MAP_TO_HYPHEN_LANG is gone");
      // Every way a dictionary is asked for, as of 0.25.1: the loader map is
      // read in one place, the detector's map in one, and loadPattern is
      // called with a literal or with the detector's answer, nothing else.
      const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
      if (count(/PATTERN_LOADERS/g) !== 2) fail("PATTERN_LOADERS is read in a new place");
      if (count(/LANG_MAP_TO_HYPHEN_LANG/g) !== 2) fail("LANG_MAP_TO_HYPHEN_LANG is read in a new place");
      if (!/LANG_MAP_TO_HYPHEN_LANG\[franc\(text\)\]/.test(code)) fail("the language detector no longer maps franc's answer");
      const calls = [...code.matchAll(/\.loadPattern\(([^)]*)\)/g)].map((match) => match[1]);
      const literal = calls.flatMap((argument) => /^"([\w-]+)"$/.exec(argument)?.[1] ?? []);
      if (calls.length !== literal.length + 1 || !/const lang = languageDetector\.detect\(content\);[^]{0,400}hyphen\.loadPattern\(lang\)/.test(code)) {
        fail(`loadPattern is called in a new way (${calls.join(", ")})`);
      }
      const keep = new Set([
        ...[...detector[1].matchAll(/:\s*"([\w-]+)"/g)].map((match) => match[1]),
        ...literal,
      ]);
      const entries = loaders[1].split("\n");
      const kept = entries.filter((entry) => {
        const key = /^\t\["([\w-]+)"\]: \(\) => /.exec(entry)?.[1] ?? fail(`unexpected loader entry ${entry.trim()}`);
        return keep.has(key);
      });
      if (kept.length === entries.length) return null;
      return {
        code: code.replace(loaders[0], `const PATTERN_LOADERS = {\n${kept.join("\n")}\n};`),
        map: null,
      };
    },
  };
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

/**
 * `virtual:webkit-polyfills`: public/polyfills.js as a module, for the PDF.js
 * worker to import ahead of PDF.js (src/pdf/pdf.worker.ts). index.html runs
 * the same file as a classic script before the app; Vite will not import a
 * file out of public/ directly.
 */
function webkitPolyfillsModulePlugin(): Plugin {
  const id = "virtual:webkit-polyfills";
  const file = path.resolve("public/polyfills.js");
  return {
    name: "webkit-polyfills-module",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(loadId) {
      if (loadId !== `\0${id}`) return null;
      this.addWatchFile(file);
      return readFileSync(file, "utf8");
    },
  };
}

/**
 * Minifies dist/polyfills.js, which Vite copies out of public/ as it is. The
 * window loads it before the app on every launch, so it counts against the
 * eager JavaScript budget (scripts/app-size-report.mjs); the readable source,
 * comments included, is several times the size. The worker's copy is already
 * minified as part of its bundle.
 */
function minifyPolyfillsPlugin(): Plugin {
  let outDir = "";
  return {
    name: "minify-polyfills",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const file = path.join(outDir, "polyfills.js");
      const { code, errors } = minifySync(file, readFileSync(file, "utf8"));
      if (errors.length) throw new Error(`Could not minify polyfills.js: ${errors.map((error) => error.message).join("; ")}`);
      writeFileSync(file, code);
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
  if (id.includes("/node_modules/@codemirror/") || id.includes("/node_modules/@uiw/react-codemirror/")) return "editor";
  if (id.includes("pdfjs-dist")) return "pdf-reader";
  if (id.includes("gsap")) return "motion";
  // Match react/react-dom exactly: the loose prefix also caught react-joyride,
  // react-medium-image-zoom, etc., forcing them into the eager ui chunk.
  if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/") || id.includes("node_modules/lucide-react")) return "ui";
  return undefined;
};

// https://vite.dev/config/
export default defineConfig(() => ({
  define: {
    "import.meta.env.LATTICE_FLAVOR": JSON.stringify(flavor),
  },
  plugins: [
    // React Compiler auto-memoizes components it can prove safe, and silently
    // skips the rest (e.g. anything the react-hooks lint still flags), so it is
    // safe to enable across the app before every warning is cleaned up.
    react(),
    lingui(),
    // Babel applies presets right-to-left: Lingui macros must expand first so
    // the compiler sees ordinary React rather than macro-generated components.
    babel({
      presets: [
        reactCompilerPreset({ target: "19", eslintSuppressionRules: reactCompilerSuppressionRules }),
        linguiTransformerBabelPreset(),
      ],
    }),
    tailwindcss(),
    pdfjsAssetsPlugin(),
    privateFontsPlugin(),
    shikiTrim.plugin,
    univerHyphenTrimPlugin(),
    webkitPolyfillsModulePlugin(),
    minifyPolyfillsPlugin(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(fileURLToPath(new URL(".", import.meta.url)), "src"),
    },
  },

  // The PDF.js worker (src/pdf/pdfjs-runtime.ts) is the only worker. PDF.js
  // starts it as a module, and its wasm loaders read `import.meta.url`.
  worker: {
    format: "es",
    plugins: () => [webkitPolyfillsModulePlugin()],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: {
    rolldownOptions: {
      // One entry, on purpose: scripts/app-size-report.mjs expects the app's
      // chunks only.
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
      // `literature-worker/.wrangler` is a local `wrangler dev` Worker's Durable
      // Object state. Its SQLite WAL files are rewritten on every request, and
      // watching them made Vite full-reload the app mid-session.
      //
      // Matched as regexes rather than globs: a glob is evaluated per path, so
      // events for a directory tree the dev server recreates (wrangler restart)
      // slipped through before the pattern applied to its descendants.
      ignored: [/[\\/]src-tauri[\\/]/, /[\\/]literature-worker[\\/]\.wrangler[\\/]/],
    },
  },
}));
