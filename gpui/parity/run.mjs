#!/usr/bin/env node
// The parity harness: renders the same scene in the Tauri app's frontend and
// in the GPUI app, and diffs them region by region (gpui/README.md, "Parity
// harness").
//
//   node gpui/parity/run.mjs --out DIR [--theme light,dark] [--screen mainWindow]
//        [--app gpui/target/release/lattice-gpui] [--bench-url URL]
//
// Without --bench-url it serves the mock-backend page itself (pnpm perf:bench
// --serve, a production build of 40 s to 2 min) and stops it at the end. The
// GPUI app is the release build (`cargo build --release` in gpui/; with
// `--features lattice-gpui/offscreen-shots` it captures with the screen
// locked). Both apps show the tutorial's PDF as the web demo ships it
// (tools/web-demo/content/compiled/main.pdf, kept current by
// scripts/web-demo-content.test.ts), so no TeX is needed.
//
// It writes DIR/report.md and DIR/report.json, and per screen
// and theme the side-by-side image and heatmap, with every capture under
// DIR/runs/. It exits 0 once the report is written, whatever it found: the
// report is the result.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { servePdf } from "../../design-system/screens/tutorial.mjs";
import { diffScreen, writeImages } from "./diff.mjs";
import { captureGpui, stageProject } from "./gpui.mjs";
import { captureReference } from "./reference.mjs";
import { SCREENS } from "./regions.mjs";
import { markdownReport } from "./report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const out = flag("--out") && resolve(flag("--out"));
if (!out) throw new Error("usage: node gpui/parity/run.mjs --out DIR [--theme light,dark] [--screen mainWindow] [--app PATH] [--bench-url URL]");
const themes = flag("--theme", "light,dark").split(",");
const screens = flag("--screen", Object.keys(SCREENS).join(",")).split(",");
for (const screen of screens) if (!SCREENS[screen]) throw new Error(`no screen ${screen}; screens: ${Object.keys(SCREENS).join(", ")}`);
const app = resolve(flag("--app", join(repo, "gpui/target/release/lattice-gpui")));
const log = (message) => process.stderr.write(`parity: ${message}\n`);

/** Serve the mock-backend page; resolves to { url, stop }. */
function serveBench() {
  log("serving the mock-backend page (pnpm perf:bench --serve)…");
  const child = spawn(process.execPath, [join(repo, "scripts/perf-bench.mjs"), "--serve", "--port", "0"], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolveUrl, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const url = /http:\/\/127\.0\.0\.1:\d+\/\S+/.exec(buffer)?.[0];
      if (url) resolveUrl({ url, stop: () => child.kill("SIGTERM") });
    });
    child.once("exit", (code) => reject(new Error(`perf-bench exited with ${code} before serving`)));
  });
}

const runs = join(out, "runs");
mkdirSync(runs, { recursive: true });
const bench = flag("--bench-url") ? { url: flag("--bench-url"), stop: () => {} } : await serveBench();
const pdf = join(repo, "tools/web-demo/content/compiled/main.pdf");
const served = await servePdf(pdf);
const results = [];
try {
  for (const screen of screens) {
    const spec = SCREENS[screen];
    for (const theme of themes) {
      // Named as the app names the tutorial it creates (lattice-core's
      // TUTORIAL_PROJECT_NAME, the mock backend's TUTORIAL_ROOT): a folder
      // Lattice adopts takes its name, which the titlebar shows.
      const project = stageProject(join(out, "Understanding Attention"), pdf);
      // GPUI first: the reference is captured at the size and scale the GPUI window got.
      log(`${screen} ${theme}: GPUI…`);
      const gpui = [
        captureGpui({ app, project, theme, screen, dir: runs, name: `${screen}-${theme}-gpui-1` }),
        captureGpui({ app, project, theme, screen, dir: runs, name: `${screen}-${theme}-gpui-2` }),
      ];
      const env = { benchUrl: bench.url, pdfUrl: served.url, viewport: gpui[0].viewport, deviceScaleFactor: gpui[0].scale };
      log(`${screen} ${theme}: reference at ${env.viewport.width}×${env.viewport.height} @${env.deviceScaleFactor}x…`);
      const ref = [];
      for (const n of [1, 2]) {
        const name = `${screen}-${theme}-reference-${n}`;
        ref.push({ ...(await captureReference(screen, theme, env, runs, name)), pngPath: join(runs, `${name}.png`) });
      }
      log(`${screen} ${theme}: diffing…`);
      const { report, images } = diffScreen(spec, { ref, gpui });
      const prefix = `${screen}-${theme}`;
      writeImages(images, join(out, prefix));
      results.push({ report, prefix });
    }
  }
} finally {
  served.close();
  bench.stop();
}

const meta = { date: new Date().toISOString(), app, benchUrl: bench.url };
const markdown = markdownReport(results, meta);
writeFileSync(join(out, "report.md"), markdown);
writeFileSync(join(out, "report.json"), JSON.stringify({ ...meta, screens: results.map((r) => r.report) }, null, 2));
for (const { report: { screen, theme, summary: s } } of results) {
  log(`${screen} · ${theme}: bounds ${s.bounds.passed}/${s.bounds.total}, text ${s.text.passed}/${s.text.total}, chrome ${s.chrome.passed}/${s.chrome.total}, pixels ${s.pixels ? `${(s.pixels.rate * 100).toFixed(2)}% (budget ${(s.pixels.budget * 100).toFixed(2)}%, GPUI run-to-run ${(s.pixels.gpuiNoiseRate * 100).toFixed(2)}%)` : "not compared"}`);
}
log(`report: ${join(out, "report.md")}`);
