// Prove a staged presentation runtime still serves the slide editor: start its
// server.mjs over the tutorial project, then request every module the editor
// and the tutorial deck import, as the webview would. Each request runs Vite's
// transform (Tailwind, the React plugin, Open Slide's plugins, the optimized
// dependencies), so a file the staging prune removed but the editor, a deck,
// or an export path needs fails here rather than in a user's app.
//
//   node scripts/check-presentation-runtime.mjs [runtimeRoot]
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMain, projectRoot } from "./lib/util.mjs";

const DECK = "understanding-attention";
const READY_TIMEOUT_MS = 120_000;
const MODULE_LIMIT = 5_000;

/** Wait for the server's one-line JSON readiness handshake on stdout. */
function awaitReady(child, stderr) {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("Open Slide did not become ready")), READY_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.includes('"ready":true'));
      if (!line) return;
      clearTimeout(timer);
      resolveReady(JSON.parse(line));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Open Slide exited with ${code} before it was ready:\n${stderr()}`));
    });
  });
}

/** Absolute same-origin module URLs a Vite-served module imports. */
function importedUrls(source) {
  const urls = new Set();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)"(\/[^"]+)"/g)) urls.add(match[1]);
  // Open Slide's virtual slides module loads each deck from a computed URL.
  for (const match of source.matchAll(/BASE_URL \+ "(@fs\/[^"?]+)/g)) urls.add(`/${match[1]}?import`);
  return urls;
}

export async function checkPresentationRuntime(runtimeRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "lattice-presentation-check-"));
  const shadow = join(workspace, "workspace");
  cpSync(join(projectRoot, "src-tauri/templates/tutorial"), shadow, { recursive: true });
  let stderr = "";
  const child = spawn(process.execPath, [join(runtimeRoot, "server.mjs")], {
    cwd: shadow,
    env: {
      ...process.env,
      OPEN_SLIDE_SHADOW_ROOT: shadow,
      OPEN_SLIDE_CACHE_ROOT: join(workspace, "cache"),
      OPEN_SLIDE_CONTROL_TOKEN: "presentation-runtime-check",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const { port, sessionToken } = await awaitReady(child, () => stderr);
    const origin = `http://127.0.0.1:${port}`;
    // The bootstrap activates the session; later requests pass as the
    // webview's own same-origin module loads.
    const bootstrap = await fetch(`${origin}/__lattice/bootstrap?token=${encodeURIComponent(sessionToken)}`);
    if (!bootstrap.ok) throw new Error(`Bootstrap failed with ${bootstrap.status}`);
    const headers = { "sec-fetch-site": "same-origin" };
    const page = await fetch(`${origin}/s/${DECK}`, { headers });
    if (!page.ok) throw new Error(`The deck page failed with ${page.status}`);
    const html = await page.text();
    const pending = [...html.matchAll(/<script type="module" src="(\/[^"]+)"/g)].map((match) => match[1]);
    for (const url of importedUrls(html)) pending.push(url);
    const visited = new Set();
    const failures = [];
    while (pending.length > 0) {
      const url = pending.pop();
      if (visited.has(url)) continue;
      visited.add(url);
      if (visited.size > MODULE_LIMIT) throw new Error(`More than ${MODULE_LIMIT} editor modules`);
      const response = await fetch(`${origin}${url}`, { headers });
      const body = await response.text();
      if (!response.ok) {
        failures.push(`${url}: ${response.status} ${body.slice(0, 500)}`);
        continue;
      }
      if (/javascript/.test(response.headers.get("content-type") ?? "")) {
        for (const imported of importedUrls(body)) pending.push(imported);
      }
    }
    if (failures.length > 0) throw new Error(`Open Slide could not serve:\n${failures.join("\n")}`);
    if (![...visited].some((url) => url.includes(`/slides/${DECK}/index.tsx`))) {
      throw new Error(`The editor never imported the ${DECK} deck`);
    }
    return visited.size;
  } finally {
    if (child.exitCode === null) {
      await new Promise((resolveExit) => {
        child.once("exit", resolveExit);
        child.kill("SIGTERM");
      });
    }
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const runtimeRoot = resolve(process.argv[2] ?? join(projectRoot, "src-tauri/presentation-runtime"));
  const modules = await checkPresentationRuntime(runtimeRoot);
  console.log(`Open Slide served ${modules} editor modules from ${runtimeRoot}`);
}
