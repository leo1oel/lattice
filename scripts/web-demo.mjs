#!/usr/bin/env node
/**
 * The website's interactive demo (tools/web-demo/): the real app over an
 * in-memory backend holding the tutorial, as a static folder for the site's
 * /demo/ path.
 *
 *   node scripts/web-demo.mjs --build-only DIR   build into DIR (new or empty) and check it
 *   node scripts/web-demo.mjs --serve [--port N]  build, check, and serve it until interrupted
 *   node scripts/web-demo.mjs --smoke             build, check, serve, and prove the app opens
 *                                                 the tutorial in headless Chrome (exit 1 if not)
 *   --dist DIR    serve or smoke-check a folder --build-only made instead of building
 *
 * The build is the production config with the demo flavor
 * (LATTICE_WEB_DEMO=1, which leaves out the Agent, tldraw and Open Slide),
 * relative asset paths (it is served from a subfolder), no private fonts and
 * no VITE_ variables. Every build is then checked, and a failed check exits 1:
 *
 *   - no Timeless font, by name or by bytes (check-font-leaks.mjs `site`);
 *   - nothing from the performance bench or tldraw, and no absolute asset path;
 *   - what a first visit downloads before the app can draw (startupBytes,
 *     gzipped) stays under STARTUP_BUDGET.
 *
 * The compiled tutorial it shows is prepared by scripts/web-demo-content.mjs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { checkSite, timelessFontHashes } from "./check-font-leaks.mjs";
import { isMain, projectRoot, walkFiles } from "./lib/util.mjs";
import { PRIVATE_FONTS_DEFAULT_DIRECTORY } from "./private-fonts.ts";

const DEMO = path.join(projectRoot, "tools/web-demo");
const PORT = 18490;
/**
 * Gzipped bytes of the JavaScript and CSS that must arrive before the app
 * can draw (startupBytes); fonts, the PDF and lazy chunks come after. The
 * build measured 815 KB when this was set (about 150 KB of it the tutorial's
 * own files); raise it only with the reason.
 */
const STARTUP_BUDGET = 1_000_000;
/** Text that must not be in a public build: the bench's fixture and hooks, and tldraw (licensed for the app only). */
const FORBIDDEN = [/lattice-perf-fixture/, /__latticeBench/, /@tldraw\//, /tldraw\.com\/license/i, /VITE_TLDRAW_LICENSE_KEY/];

function parseArgs(argv) {
  const options = { buildOnly: null, dist: null, serve: false, smoke: false, port: PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build-only") options.buildOnly = path.resolve(argv[++index] ?? "");
    else if (arg === "--dist") options.dist = path.resolve(argv[++index] ?? "");
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown option ${arg}; see the header of scripts/web-demo.mjs`);
  }
  if (!options.buildOnly && !options.serve && !options.smoke) throw new Error("Pass --build-only DIR, --serve or --smoke");
  if (options.buildOnly && options.dist) throw new Error("--dist uses a build; it cannot take --build-only");
  return options;
}

/** The demo's production build into `outDir`, which it empties. */
async function buildDemo(outDir) {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} has files in it; build into a new or empty folder`);
  // Read by vite.config.ts and scripts/private-fonts.ts as the config loads.
  for (const name of Object.keys(process.env)) if (name.startsWith("VITE_")) delete process.env[name];
  process.env.LATTICE_WEB_DEMO = "1";
  process.env.LATTICE_PRIVATE_FONTS_DIR = "";
  delete process.env.LATTICE_PRIVATE_FONTS_REQUIRED;
  const { build } = await import("vite");
  // Lingui finds its config from the working directory.
  const cwd = process.cwd();
  process.chdir(projectRoot);
  try {
    await build({
      root: DEMO,
      configFile: path.join(projectRoot, "vite.config.ts"),
      // No .env file is read: tools/web-demo has none.
      envDir: DEMO,
      publicDir: path.join(projectRoot, "public"),
      base: "./",
      logLevel: "warn",
      clearScreen: false,
      build: { outDir, emptyOutDir: true, manifest: true },
      plugins: [{
        name: "web-demo-entry",
        // The app config names its own index.html as the one input; the demo is the only one here.
        config(config) {
          config.build.rolldownOptions.input = { demo: path.join(DEMO, "index.html") };
          // The page installs its backend before the app's modules run.
          config.build.rolldownOptions.output = { ...config.build.rolldownOptions.output, strictExecutionOrder: true };
        },
      }],
    });
  } finally {
    process.chdir(cwd);
  }
}

/**
 * What a first visit fetches before the app draws: the page's chunk, the
 * modules it loads at once (the backend, the project, the app's main.tsx),
 * and their static imports and stylesheets.
 */
function startupBytes(outDir) {
  const manifest = JSON.parse(readFileSync(path.join(outDir, ".vite/manifest.json"), "utf8"));
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry && chunk.src?.endsWith("index.html"));
  if (!entry) throw new Error("The build's manifest has no index.html entry");
  const files = new Set();
  const visit = (chunk) => {
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const key of chunk.imports ?? []) visit(manifest[key]);
  };
  visit(entry);
  // The page's own chunk holds the dynamic imports of the backend and the app.
  for (const chunk of [...files].map((file) => Object.values(manifest).find((candidate) => candidate.file === file))) {
    for (const key of chunk?.dynamicImports ?? []) visit(manifest[key]);
  }
  files.add("polyfills.js");
  let bytes = 0;
  for (const file of files) bytes += gzipSync(readFileSync(path.join(outDir, file)), { level: 9 }).length;
  return { bytes, files: files.size };
}

/** Every check a build must pass; the findings, empty when it passes. */
export function checkBuild(outDir) {
  const findings = checkSite(outDir, timelessFontHashes({ fontsDirectory: defaultFontsDirectory(), emittedDirectory: outDir }));
  const html = readFileSync(path.join(outDir, "index.html"), "utf8");
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) findings.push(`index.html loads ${match[1]} from the server's root; the demo is served from a subfolder`);
  for (const file of walkFiles(outDir)) {
    if (!/\.(?:js|css|html|json)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) if (pattern.test(text)) findings.push(`${path.relative(outDir, file)} holds ${pattern}`);
  }
  const { bytes } = startupBytes(outDir);
  if (bytes > STARTUP_BUDGET) findings.push(`the app's startup download is ${kb(bytes)} gzipped, over the ${kb(STARTUP_BUDGET)} budget`);
  return findings;
}

/** Where scripts/private-fonts.ts looks by default, so a copy of a face on this machine is caught too. */
function defaultFontsDirectory() {
  return existsSync(PRIVATE_FONTS_DEFAULT_DIRECTORY) ? PRIVATE_FONTS_DEFAULT_DIRECTORY : null;
}

const kb = (bytes) => `${(bytes / 1000).toFixed(0)} KB`;

function report(outDir) {
  const files = walkFiles(outDir);
  const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
  const { bytes, files: startupFiles } = startupBytes(outDir);
  console.log(`Web demo in ${outDir}: ${files.length} files, ${(total / 1e6).toFixed(1)} MB on disk; startup download ${kb(bytes)} gzipped in ${startupFiles} files.`);
  const findings = checkBuild(outDir);
  for (const finding of findings) console.error(`web demo check: ${finding}`);
  if (findings.length) throw new Error(`The web demo build failed ${findings.length} check${findings.length === 1 ? "" : "s"}`);
}

async function serve(outDir, port) {
  const { preview } = await import("vite");
  const server = await preview({
    root: DEMO, configFile: false, base: "./", logLevel: "warn",
    build: { outDir }, preview: { port, strictPort: port !== 0, host: "127.0.0.1" },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("The preview server did not report its address");
  return { server, url };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.dist ?? options.buildOnly ?? path.join(projectRoot, ".tmp/web-demo-dist");
  if (!options.dist) {
    if (!options.buildOnly) spawnSync("rm", ["-rf", outDir]);
    console.error("web-demo: building…");
    await buildDemo(outDir);
  }
  report(outDir);
  if (options.buildOnly) return;
  const { server, url } = await serve(outDir, options.smoke && !options.serve ? 0 : options.port);
  if (options.smoke) {
    // Not spawnSync: this process serves the page the check loads.
    const smoke = spawn(process.execPath, [path.join(projectRoot, "scripts/perf-bench.mjs"), "--smoke", "--url", `${url}?lang=en`], { stdio: "inherit" });
    const [code] = await once(smoke, "exit");
    if (code !== 0) process.exitCode = 1;
    if (!options.serve) {
      await server.close();
      return;
    }
  }
  console.log(`Lattice web demo: ${url}`);
  console.log("Stop it with Ctrl-C.");
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`web-demo: ${error.message}`);
    process.exit(1);
  });
}
