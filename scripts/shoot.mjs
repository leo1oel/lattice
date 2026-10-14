#!/usr/bin/env node
/**
 * Screenshots of the mock-backend page (docs/driving-the-app.md) over a grid of
 * scenes × themes × languages × widths, for PR images and visual QA. One shared
 * driver, so a task does not write its own, and a bounded one: every shot has a
 * deadline and so does the whole run, so a hung page or browser fails loudly
 * instead of holding a pueue slot.
 *
 * Usage: node scripts/shoot.mjs --out DIR [options]
 *   --out DIR          where the PNGs go (created); keep it outside the checkout,
 *                      which the dev server watches
 *   --url URL          shoot a page already served (`pnpm perf:bench --serve`);
 *                      without it, this serves its own and stops it at the end
 *   --dev              serve with the dev server (no production build)
 *   --scenes FILE      a module whose default export maps scene names to scenes
 *                      (below); without it the one scene is the page as it opens
 *   --only a,b         shoot only these scenes
 *   --query Q          a URL query each scene is shot with, such as
 *                      'build=failed' (repeatable: every query is its own row)
 *   --theme a,b        light, dark or system (default light,dark)
 *   --lang a,b         en, zh-CN or system (default en)
 *   --locale a,b       the browser's language, which lang=system follows
 *   --width a,b        viewport widths in CSS px (default 1440)
 *   --height N         viewport height (default 900)
 *   --scale N          device pixel ratio (default 2)
 *   --engine NAME      chromium (default) or webkit (Playwright's WebKit,
 *                      closer to the WKWebView release builds render in)
 *   --ready SELECTOR   what to wait for before a scene runs (default: the
 *                      fixture's root document in the editor; the welcome
 *                      screen of `--query welcome=1` needs `.welcome-screen`)
 *   --settle MS        quiet time after the page is ready and after the scene (default 500)
 *   --shot-timeout S   the most one shot may take, load included (default 60)
 *   --timeout S        the most the whole run may take, build included (default 600)
 *   --headful          show the browser
 *
 * A scene is `async (page, shot) => {}`, run on a Playwright page after the app
 * is ready, or an object { run, query, ready, selector }: `query` is added to
 * the URL, `ready` overrides --ready, and `selector` screenshots one element
 * instead of the viewport. `shot` holds the cell (theme, lang, locale, width,
 * height, engine, url) and `shot.capture(label)`, which writes an extra image
 * mid-scene. For example:
 *
 *   export default {
 *     palette: async (page) => { await page.keyboard.press("Meta+Shift+P"); },
 *     failed: { query: "build=failed", run: async (page) => {} },
 *   };
 *
 * Files are named <scene>[-<query>]-<theme>-<lang>[-<locale>]-<width>[-webkit].png.
 * The first failed shot stops the run with exit 1, printing its error, the
 * page's console errors and failed requests, and a screenshot of the failure.
 * The overall timeout exits 124 with what was running.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";
import { chromium, webkit } from "playwright-core";
import { launchChrome } from "./perf-bench/cdp.mjs";
import { APP_READY } from "./perf-bench/selectors.mjs";
import { exitOnSignals, onShutdown, once } from "./perf-bench/shutdown.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const list = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);

function parseArgs(argv) {
  const options = {
    out: null, url: null, dev: false, scenes: null, only: null, queries: [], themes: ["light", "dark"], langs: ["en"], locales: [null],
    widths: [1440], height: 900, scale: 2, engine: "chromium", ready: null, settle: 500, shotTimeout: 60, timeout: 600, headful: false,
  };
  const number = (arg, value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${arg} takes a positive number`);
    return parsed;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} takes a value`);
      return next;
    };
    if (arg === "--out") options.out = path.resolve(value());
    else if (arg === "--url") options.url = value();
    else if (arg === "--dev") options.dev = true;
    else if (arg === "--scenes") options.scenes = path.resolve(value());
    else if (arg === "--only") options.only = list(value());
    else if (arg === "--query") options.queries.push(value().replace(/^\?/, ""));
    else if (arg === "--theme") options.themes = list(value());
    else if (arg === "--lang") options.langs = list(value());
    else if (arg === "--locale") options.locales = list(value());
    else if (arg === "--width") options.widths = list(value()).map((width) => number(arg, width));
    else if (arg === "--height") options.height = number(arg, value());
    else if (arg === "--scale") options.scale = number(arg, value());
    else if (arg === "--engine") options.engine = value();
    else if (arg === "--ready") options.ready = value();
    else if (arg === "--settle") options.settle = Number(value());
    else if (arg === "--shot-timeout") options.shotTimeout = number(arg, value());
    else if (arg === "--timeout") options.timeout = number(arg, value());
    else if (arg === "--headful") options.headful = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.out) throw new Error("--out DIR is required");
  if (options.url && options.dev) throw new Error("--dev serves its own page; it cannot take --url");
  if (!["chromium", "webkit"].includes(options.engine)) throw new Error("--engine takes chromium or webkit");
  for (const theme of options.themes) if (!["light", "dark", "system"].includes(theme)) throw new Error(`Unknown theme ${theme}`);
  for (const lang of options.langs) if (!["en", "zh-CN", "system"].includes(lang)) throw new Error(`Unknown lang ${lang}`);
  if (!Number.isFinite(options.settle) || options.settle < 0) throw new Error("--settle takes milliseconds");
  return options;
}

async function loadScenes(options) {
  const loaded = options.scenes ? (await import(pathToFileURL(options.scenes).href)).default : { page: async () => {} };
  if (!loaded || typeof loaded !== "object") throw new Error(`${options.scenes} must default-export an object of scenes`);
  const scenes = Object.entries(loaded).map(([name, scene]) => ({ name, ...(typeof scene === "function" ? { run: scene } : scene) }));
  for (const scene of scenes) if (scene.run && typeof scene.run !== "function") throw new Error(`Scene ${scene.name}: run must be a function`);
  const kept = options.only ? scenes.filter((scene) => options.only.includes(scene.name)) : scenes;
  if (!kept.length) throw new Error(`No scene matches ${options.only ?? "(the scenes file is empty)"}`);
  return kept;
}

/** Every cell of the grid, in the order shot: scene by scene, so one scene's variants sit together in the output. */
function grid(options, scenes) {
  const slug = (query) => query.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const cells = [];
  for (const scene of scenes) for (const query of options.queries.length ? options.queries : [""])
    for (const theme of options.themes) for (const lang of options.langs) for (const locale of options.locales) for (const width of options.widths) {
      const name = [scene.name, slug(query), theme, lang, locale, width, options.engine === "webkit" ? "webkit" : null].filter(Boolean).join("-");
      cells.push({ name, scene, query, theme, lang, locale, width, height: options.height, engine: options.engine });
    }
  const seen = new Set();
  for (const { name } of cells) {
    if (seen.has(name)) throw new Error(`Two shots would both write ${name}.png: give the scenes or queries distinct names`);
    seen.add(name);
  }
  return cells;
}

function cellUrl(base, cell) {
  const url = new URL(base);
  url.searchParams.set("theme", cell.theme);
  url.searchParams.set("lang", cell.lang);
  for (const query of [cell.query, cell.scene.query ?? ""]) {
    for (const [key, value] of new URLSearchParams(query)) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Resolves with `promise`, or rejects once `ms` pass; never leaves a timer
 * holding the process open. `what` may be a function, read when time runs out.
 */
function deadline(promise, ms, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${typeof what === "function" ? what() : what} took over ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * `pnpm perf:bench --serve` as a child: its build progress goes to our
 * stderr, and the URL it prints once the page answers is the base of every
 * shot. Stopped with SIGTERM, which lets it remove its build directory.
 */
function servePage(options) {
  const args = [path.join(repo, "scripts/perf-bench.mjs"), "--serve", "--port", "0", ...(options.dev ? ["--dev"] : [])];
  const child = spawn(process.execPath, args, { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  const stop = once(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    // perf-bench's own grace for cleanup is 15 s.
    if ((await Promise.race([gone.then(() => true), sleep(20_000, false)])) === false) child.kill("SIGKILL");
  });
  const unregister = onShutdown(stop);
  process.on("exit", () => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
  const url = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/^\s+(http:\/\/\S+)$/m);
      if (match) resolve(match[1]);
    });
    gone.then((code) => reject(new Error(`perf-bench --serve exited (${code}) before printing its URL:\n${output}`)));
  });
  return { url, stop: () => stop().finally(unregister) };
}

/** A browser that gives each shot its own context: theme, language and storage never leak between shots. */
async function openBrowser(options) {
  if (options.engine === "webkit") {
    const browser = await webkit.launch({ headless: !options.headful });
    return { browser, close: () => browser.close() };
  }
  // perf-bench's Chrome finder, which falls back to Playwright's Chrome for
  // Testing where Google Chrome is not installed, and removes its profile.
  const chrome = await launchChrome({ headless: !options.headful });
  const browser = await chromium.connectOverCDP(chrome.endpoint);
  return { browser, close: () => browser.close().catch(() => {}).finally(() => chrome.close()) };
}

/** Waits for `ready` (a CSS selector, or a function of the page), then for fonts, two frames and `settle` ms of quiet. */
async function settle(page, ready, settleMs) {
  if (typeof ready === "function") await ready(page);
  else if (ready) await page.waitForSelector(ready, { state: "visible", timeout: 0 });
  else await page.waitForFunction(APP_READY, null, { timeout: 0, polling: 100 });
  await page.evaluate("document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  await page.waitForTimeout(settleMs);
}

async function shoot(cell, { browser, base, options, setStep }) {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: options.scale,
    ...(cell.locale ? { locale: cell.locale } : {}),
  });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => message.type() === "error" && problems.push(`[console] ${message.text()}`));
  page.on("pageerror", (error) => problems.push(`[exception] ${error.message}`));
  page.on("requestfailed", (request) => problems.push(`[request failed] ${request.failure()?.errorText ?? ""} ${request.url()}`));
  page.on("response", (response) => response.status() >= 400 && problems.push(`[request ${response.status()}] ${response.url()}`));
  const url = cellUrl(base, cell);
  const file = (label) => path.join(options.out, `${cell.name}${label ? `~${label}` : ""}.png`);
  let stage = "starting";
  const at = (next) => {
    stage = next;
    setStep(`${cell.name}: ${next}`);
  };
  const work = async () => {
    at("loading");
    await page.goto(url, { waitUntil: "load", timeout: 0 });
    const ready = cell.scene.ready ?? options.ready;
    at(`waiting for ${typeof ready === "function" ? "the scene's ready()" : ready ?? "the app to open the fixture project"}`);
    await settle(page, ready, options.settle);
    at("running the scene");
    const shot = { ...cell, scene: cell.scene.name, url, capture: async (label) => page.screenshot({ path: file(label), animations: "disabled", caret: "hide" }) };
    await cell.scene.run?.(page, shot);
    await page.waitForTimeout(options.settle);
    at("capturing");
    const target = cell.scene.selector ? page.locator(cell.scene.selector).first() : page;
    await target.screenshot({ path: file(), animations: "disabled", caret: "hide", timeout: 0 });
  };
  try {
    await deadline(work(), options.shotTimeout * 1000, () => `the shot ${cell.name} (${stage})`);
    console.log(`ok ${file()}`);
  } catch (error) {
    console.log(`FAILED ${cell.name}: ${error.message.split("\n")[0]}`);
    console.log(`  Page: ${url}`);
    console.log(`  Console errors and failed requests:\n${problems.length ? problems.slice(0, 30).map((line) => `    ${line.slice(0, 1_000)}`).join("\n") : "    (none)"}`);
    const failed = path.join(options.out, `${cell.name}.FAILED.png`);
    if (await deadline(page.screenshot({ path: failed, timeout: 0 }), 5_000, "the failure screenshot").then(() => true, () => false)) console.log(`  Screenshot: ${failed}`);
    throw error;
  } finally {
    // A page stuck in a busy loop can hold close() too.
    await deadline(context.close(), 10_000, "closing the shot's page").catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenes = await loadScenes(options);
  const cells = grid(options, scenes);
  mkdirSync(options.out, { recursive: true });

  let step = "starting";
  const setStep = (next) => (step = next);
  const resources = [];
  const cleanup = once(() => Promise.all(resources.map((close) => deadline(Promise.resolve().then(close), 20_000, "cleanup").catch(() => {}))));
  exitOnSignals({ describe: (signal) => `shoot: ${signal} while ${step}` });
  // The hard stop: whatever hangs (a build, a browser that never answers, a
  // scene awaiting something that never comes), the run ends here.
  const hardStop = setTimeout(() => {
    console.error(`shoot: the run took over ${options.timeout} s, stopping while ${step}`);
    cleanup().finally(() => process.exit(124));
  }, options.timeout * 1000);

  try {
    let base = options.url;
    if (!base) {
      setStep("serving the bench page");
      const served = servePage(options);
      resources.push(served.stop);
      base = await served.url;
    }
    setStep(`starting ${options.engine}`);
    const browser = await openBrowser(options);
    resources.unshift(browser.close);
    console.error(`shoot: ${cells.length} shot${cells.length === 1 ? "" : "s"} into ${options.out}`);
    for (const cell of cells) await shoot(cell, { browser: browser.browser, base, options, setStep });
    console.log(`Done: ${cells.length} shot${cells.length === 1 ? "" : "s"} in ${options.out}`);
  } catch (error) {
    console.error(`shoot: ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    setStep("cleaning up");
    await cleanup();
    clearTimeout(hardStop);
  }
}

await main().catch((error) => {
  console.error(`shoot: ${error.message}`);
  process.exit(1);
});
