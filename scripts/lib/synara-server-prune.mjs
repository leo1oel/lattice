// Prunes the staged Synara server (prepare-synara-sidecar.mjs) down to
// what the bundled runtime loads: the npm artifacts every runtime drops, and
// the trees only Synara's server can do without.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pruneNodeModules } from "./runtime-prune.mjs";
import { removePath, walkFiles } from "./util.mjs";

/**
 * npm packages often publish source maps, typings, docs, tests, and native
 * binaries for every supported platform. They are useful to package authors,
 * but never loaded by the staged production runtime and previously inflated
 * the installed app by hundreds of megabytes. The categories every runtime
 * shares live in lib/runtime-prune.mjs; the trees below are Synara's own.
 */
export function pruneServerRuntime(stageRoot, { target, platform }) {
  const serverRoot = join(stageRoot, "server");
  const distRoot = join(serverRoot, "dist");
  let removedBytes = 0;
  const removeFiles = (root, test) => {
    for (const path of walkFiles(root)) if (test(path)) removedBytes += removePath(path);
  };
  const removeEntries = (directory, test) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) if (test(entry)) removedBytes += removePath(join(directory, entry));
  };

  removeFiles(distRoot, (path) => path.endsWith(".map"));

  const junkDirectories = [
    // Typings packages: nothing typechecks at runtime.
    "node_modules/@types",
    // ConPTY is Windows-only; keep it when staging a Windows runtime.
    ...(target === "x86_64-pc-windows-msvc" ? [] : ["node_modules/node-pty/third_party"]),
    // The server's only use of @pierre/diffs is parsePatchFiles (checkpointing/
    // Diffs.ts; assertServerNeverHighlights holds that), which never highlights:
    // Shiki imports a grammar or theme only when a highlighter is asked for that
    // language, and the dependency smoke below parses a patch without them. The
    // embedded client highlights with its own bundled copies under dist/client.
    "node_modules/@shikijs/langs",
    "node_modules/@shikijs/themes",
    // Only the native code editor's language worker loads the TypeScript
    // compiler (assertOnlyLanguageWorkerLoadsTypeScript), and the server
    // refuses that editor outside Synara Beta, while Lattice runs the Stable
    // feature boundary.
    "node_modules/typescript",
  ];
  assertServerNeverHighlights(distRoot);
  assertOnlyLanguageWorkerLoadsTypeScript(distRoot);
  // Keep installed production packages: upstream's externalized imports change
  // between releases (0.8.3 imports top-level pi-ai providers directly).
  // Prune unused artifacts, not packages based on an older bundle's graph.
  for (const directory of junkDirectories) removedBytes += removePath(join(serverRoot, directory));

  // The launcher runs dist/index.mjs; the parallel CommonJS build of the same
  // server (index.cjs and its chunks) is never executed.
  removeEntries(distRoot, (entry) => entry.endsWith(".cjs"));
  // Precompressed .br/.gz sidecars for the embedded client UI: the static
  // server falls back to the identity file when a sidecar is missing, and the
  // iframe loads over loopback where transfer compression buys nothing.
  removeFiles(join(distRoot, "client"), (path) => path.endsWith(".br") || path.endsWith(".gz"));
  removedBytes += pruneFallbackFonts(join(distRoot, "client"));

  // Nothing here runs on anything but Node, which refuses to strip types under
  // node_modules, so the TypeScript sources packages publish beside their
  // JavaScript (effect, zod, the Anthropic SDK, ...) can never load. This also
  // removes npm's .bin links, which pruned packages would leave dangling, and
  // tauri-build hard-errors on a broken link inside the resources glob.
  removedBytes += pruneNodeModules(join(serverRoot, "node_modules"), {
    platform,
    typeScriptSources: "remove",
  });

  removeEntries(join(serverRoot, "node_modules/node-pty/prebuilds"), (entry) => entry !== platform);
  return removedBytes;
}

/**
 * Pruning Shiki's grammars and themes is safe only while the server bundle
 * imports @pierre/diffs once, lazily, and takes nothing but parsePatchFiles from
 * it, and never imports Shiki itself. Loud on purpose: a runtime bump that
 * starts highlighting on the server must keep them instead.
 */
function assertServerNeverHighlights(distRoot) {
  const bundles = readdirSync(distRoot)
    .filter((entry) => entry.endsWith(".mjs") && entry !== "runtimeDependencySmoke.mjs")
    .map((entry) => readFileSync(join(distRoot, entry), "utf8"));
  const source = bundles.join("\n");
  const loader = /const (\w+) = lazyModule\(\(\) => import\("@pierre\/diffs"\)\);/.exec(source)?.[1];
  const calls = loader ? source.split(`${loader}()`).length - 1 : 0;
  const parses = loader ? source.split(`${loader}()), ({ parsePatchFiles }) =>`).length - 1 : 0;
  if (
    source.split('"@pierre/diffs"').length - 1 !== 1 ||
    !loader ||
    calls === 0 ||
    calls !== parses ||
    /(?:from\s*|import\(\s*)"(?:shiki|@shikijs\/[^"]*)"/.test(source)
  ) {
    throw new Error(
      "The Synara server bundle no longer uses @pierre/diffs for parsePatchFiles alone. "
        + "Re-check the Shiki prune in pruneServerRuntime against the pinned runtime.",
    );
  }
}

/**
 * Synara 1.0.8 made `typescript` a production dependency for the Beta native
 * editor's language worker. Pruning it is safe only while that worker is the
 * one bundle importing it; loud on purpose, like the Shiki check above.
 */
function assertOnlyLanguageWorkerLoadsTypeScript(distRoot) {
  const importers = readdirSync(distRoot).filter((entry) =>
    entry.endsWith(".mjs")
    && /(?:from\s*|import\(\s*)"typescript"/.test(readFileSync(join(distRoot, entry), "utf8")));
  if (importers.some((entry) => entry !== "languageWorker.mjs")) {
    throw new Error(
      `The Synara server bundle imports typescript outside the native editor's language worker (${importers.join(", ")}). `
        + "Re-check the typescript prune in pruneServerRuntime against the pinned runtime.",
    );
  }
}

/**
 * KaTeX's @font-face rules list woff2, then woff, then truetype. A browser takes
 * the first format it supports, and WKWebView supports woff2, so the two
 * fallbacks are never requested. Remove a font file only when every reference to
 * it anywhere in the client is such a fallback behind a woff2 source.
 */
function pruneFallbackFonts(clientRoot) {
  const assets = join(clientRoot, "assets");
  if (!existsSync(assets)) return 0;
  const texts = walkFiles(clientRoot)
    .filter((path) => /\.(?:css|js|mjs|html)$/.test(path))
    .map((path) => readFileSync(path, "utf8"));
  const fallbacks = new Map();
  for (const text of texts) {
    for (const [, sources] of text.matchAll(/@font-face\s*\{[^}]*?src:([^;}]*)/g)) {
      const urls = [...sources.matchAll(/url\(([^)]+)\)/g)].map(([, url]) => basename(url.replace(/["']/g, "")));
      if (!urls[0]?.endsWith(".woff2")) continue;
      for (const url of urls.slice(1)) fallbacks.set(url, (fallbacks.get(url) ?? 0) + 1);
    }
  }
  let removedBytes = 0;
  for (const entry of readdirSync(assets)) {
    if (!/\.(?:woff|ttf)$/.test(entry) || !fallbacks.has(entry)) continue;
    const references = texts.reduce((count, text) => count + text.split(entry).length - 1, 0);
    if (references === fallbacks.get(entry)) removedBytes += removePath(join(assets, entry));
  }
  return removedBytes;
}
