// CI-only: drive the installed WebView2, never a dev server or a mock backend.
// CDP is scoped to this test app on a disposable runner, never to its installer.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { freePort, projectRoot } from "./lib/util.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Installed-app checks run only on a disposable Windows Actions runner.");
}
const { values } = parseArgs({ options: { app: { type: "string" }, artifacts: { type: "string" } } });
if (!values.app || !values.artifacts) throw new Error("Pass --app and --artifacts");
const executable = resolve(values.app);
const artifacts = resolve(values.artifacts);
mkdirSync(artifacts, { recursive: true });
const port = await freePort();
let browser;
let page;
let child;
let startupError;
let policyAcquired = false;
const policy = (mode) => execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File",
  join(projectRoot, "scripts/windows-webview2-test-policy.ps1"), "-Mode", mode, "-Port", String(port)], { stdio: "inherit", windowsHide: true });
let output = "";
const checks = [];
async function until(label, action, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child && child.exitCode !== null) throw new Error(`Lattice exited with ${child.exitCode}`);
    try { const value = await action(); if (value) return value; } catch (caught) { error = caught; }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out: ${label}${error ? `: ${error.message}` : ""}`);
}
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const ok = (message) => { checks.push(message); console.log(`ok: ${message}`); };
try {
  policy("Acquire");
  policyAcquired = true;
  child = spawn(executable, [], {
    cwd: dirname(executable), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: join(artifacts, "webview-profile") },
  });
  child.once("error", (error) => { startupError = error; });
  child.stdout.on("data", (bytes) => { output += bytes; });
  child.stderr.on("data", (bytes) => { output += bytes; });
  await until("WebView2 startup", () => fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok));
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until("native app page", async () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().includes("tauri.localhost")));
  await until("tutorial or welcome screen", async () => await page.locator(".cm-editor").count() || await page.locator(".welcome-tutorial").count());
  if (await page.locator(".welcome-tutorial").count()) await page.locator(".welcome-tutorial").click();
  await page.locator(".cm-editor .cm-content").first().waitFor({ timeout: 90_000 });
  const project = await invoke("initial_project");
  assert.ok(project?.root, "Tutorial must be bound to this window");
  assert.match(await invoke("read_project_file", { projectRoot: project.root, path: "main.tex" }), /\\documentclass/);
  ok("installed application opens and reads the tutorial");

  const agent = await invoke("synara_ensure_ready");
  assert.equal(agent.state, "unsupported");
  assert.equal(agent.origin, null);
  ok("embedded Agent is unavailable and starts no server");

  for (const entering of [true, false]) {
    await page.keyboard.press("F11");
    await until(`native fullscreen = ${entering}`, async () => await invoke("plugin:window|is_fullscreen", { label: "main" }) === entering);
  }
  ok("F11 enters and leaves native fullscreen");

  const path = "notes/installation-é 中文.txt";
  for (const content of ["First save", "Replacement — 中文\n"]) {
    await invoke("write_project_file", { projectRoot: project.root, path, content });
    assert.equal(await invoke("read_project_file", { projectRoot: project.root, path }), content);
  }
  ok("Unicode project writes and atomic replacement round-trip");

  const callback = await page.evaluate(() => {
    globalThis.__windowsSmokeOutput = "";
    return globalThis.__TAURI_INTERNALS__.transformCallback((raw) => {
      if (Array.isArray(raw.message) || raw.message instanceof ArrayBuffer) {
        globalThis.__windowsSmokeOutput += new TextDecoder().decode(new Uint8Array(raw.message));
      }
    });
  });
  const terminal = await invoke("terminal_open", { projectRoot: project.root, cols: 100, rows: 30, onOutput: `__CHANNEL__:${callback}` });
  try {
    await invoke("terminal_resize", { id: terminal.id, cols: 80, rows: 24 });
    await invoke("terminal_write", { id: terminal.id, data: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'terminal-proof.txt'), 'Lattice ConPTY works')\r" });
    await until("real ConPTY command execution in project directory", async () => await invoke("read_project_file", { projectRoot: project.root, path: "terminal-proof.txt" }).catch(() => null) === "Lattice ConPTY works");
    await until("ConPTY output", () => page.evaluate(() => globalThis.__windowsSmokeOutput.length > 0));
  } finally {
    await invoke("terminal_close", { id: terminal.id });
    await page.evaluate((id) => globalThis.__TAURI_INTERNALS__.unregisterCallback(id), callback);
  }
  ok("real ConPTY input, output, project directory and resize");

  // Readiness must be obtained through the installed host, whose resource
  // paths point at this installation rather than the source checkout.
  const presentation = await invoke("presentation_ensure_ready", { projectRoot: project.root, pageId: "windows-installer-smoke" });
  assert.equal(presentation.state, "ready");
  assert.ok(presentation.sessionUrl && presentation.leaseId);
  try {
    const response = await fetch(presentation.sessionUrl);
    assert.ok(response.ok, `Installed Open Slide bootstrap: ${response.status}`);
  } finally {
    await invoke("presentation_release", { projectRoot: project.root, leaseId: presentation.leaseId });
  }
  ok("installed Node and Open Slide start through real IPC");
  await page.screenshot({ path: join(artifacts, "installed.png") });
  writeFileSync(join(artifacts, "checks.json"), JSON.stringify(checks, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
    writeFileSync(join(artifacts, "page.txt"), await page.locator("body").innerText().catch(() => "unavailable"));
  }
  throw error;
} finally {
  writeFileSync(join(artifacts, "process.log"), output);
  if (page) await invoke("plugin:window|close", { label: "main" }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null) await new Promise((done) => { child.once("exit", done); setTimeout(done, 10_000).unref(); });
  if (child && child.exitCode === null) child.kill();
  if (policyAcquired) policy("Release");
}
