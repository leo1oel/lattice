// Drive the installed Windows executable through its real WebView2 IPC.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { projectRoot } from "./lib/util.mjs";
import { parseArgs } from "node:util";
import { webDriver, startSession, runChecks, saveEvidence } from "./linux-e2e.mjs";

const { values } = parseArgs({ options: {
  app: { type: "string" }, driver: { type: "string", default: "http://127.0.0.1:4444" },
  artifacts: { type: "string", default: ".tmp/windows-e2e" },
} });
if (!values.app) throw new Error("Pass --app with the installed Lattice executable.");
const driver = webDriver(values.driver);
const artifacts = resolve(values.artifacts);
mkdirSync(artifacts, { recursive: true });
const guard = join(projectRoot, "scripts/windows-console-guard.ps1");
const readyPath = join(artifacts, "console-monitor.ready");
const stopPath = join(artifacts, "console-monitor.stop");
const reportPath = join(artifacts, "console-windows.json");
const monitor = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", guard, "-Mode", "Monitor", "-Ready", readyPath, "-Stop", stopPath, "-Report", reportPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let monitorLog = "";
monitor.stdout.on("data", chunk => { monitorLog += chunk; });
monitor.stderr.on("data", chunk => { monitorLog += chunk; });
const monitorExited = new Promise(resolve => { monitor.once("exit", resolve); monitor.once("error", error => { monitorLog += error.message; resolve(-1); }); });
let monitorStopped = false;
let session;
let appProcess;
async function stopMonitor() {
  if (monitorStopped) return;
  monitorStopped = true;
  writeFileSync(stopPath, "stop");
  await Promise.race([monitorExited, new Promise(resolve => setTimeout(resolve, 10_000))]);
  if (monitor.exitCode === null) monitor.kill();
  writeFileSync(join(artifacts, "console-monitor.log"), monitorLog);
  if (!existsSync(reportPath)) throw new Error(`Console monitor did not produce its report: ${monitorLog}`);
}
async function resizeWindow() {
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", guard, "-Mode", "Resize", "-AppPath", resolvePath(values.app)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Window resize failed: ${errors}`)));
  });
}
function resolvePath(value) { return resolve(value); }
async function invoke(command, args = {}) {
  const result = await driver.call("POST", `/session/${session.id}/execute/async`, {
    script: "const [command, args, done] = arguments; window.__TAURI_INTERNALS__.invoke(command, args).then(value => done({value}), error => done({error: String(error)}));",
    args: [command, args],
  });
  if (result.error) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
async function waitFor(label, script, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await session.run(script);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  const monitorDeadline = Date.now() + 30_000;
  while (!existsSync(readyPath)) {
    if (monitor.exitCode !== null || Date.now() > monitorDeadline) throw new Error(`Console monitor did not start: ${monitorLog}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // Test-only debugging configuration: never enabled by the application or
  // its installer. Attach to the real WebView2 rather than asking EdgeDriver
  // to find DevToolsActivePort in Tauri's own profile directory.
  appProcess = spawn(resolve(values.app), [], { stdio: "ignore", env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
    WEBVIEW2_USER_DATA_FOLDER: join(tmpdir(), `lattice-webdriver-${process.pid}`),
  } });
  const cdpDeadline = Date.now() + 60_000;
  while (!(await fetch("http://127.0.0.1:9222/json/version").then(response => response.ok).catch(() => false))) {
    if (appProcess.exitCode !== null || Date.now() > cdpDeadline) throw new Error("The installed WebView2 did not start its test endpoint");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  session = await startSession(driver, resolve(values.app), {
    browserName: "webview2", "ms:edgeChromium": true,
    "ms:edgeOptions": { debuggerAddress: "127.0.0.1:9222" },
  });
  await runChecks(session, console.log, "Windows");
  await resizeWindow();
  await session.keys([{ type: "keyDown", value: "\uE03B" }, { type: "keyUp", value: "\uE03B" }]);
  await waitFor("F11 fullscreen", "return document.querySelector('.app-shell')?.classList.contains('fullscreen');");
  if (!(await invoke("plugin:window|is_fullscreen", { label: "main" }))) throw new Error("F11 did not enter native fullscreen");
  await session.keys([{ type: "keyDown", value: "\uE03B" }, { type: "keyUp", value: "\uE03B" }]);
  await waitFor("F11 restoring the window", "return !document.querySelector('.app-shell')?.classList.contains('fullscreen');");
  console.log("ok: F11 enters and exits native Windows fullscreen");
  await invoke("run_doctor");
  await invoke("run_doctor");
  console.log("ok: maximized and restored Lattice three times and repeated tool checks");
  const project = await invoke("initial_project");
  if (!project?.root) throw new Error("The tutorial project is not bound to the window");
  const projectRoot = project.root;
  const source = await invoke("read_project_file", { projectRoot, path: "main.tex" });
  const formatted = await invoke("format_latex", { path: "main.tex", text: source });
  if (!formatted.includes("\\documentclass{article}")) throw new Error("LaTeX formatting did not return the document");
  console.log("ok: native Windows latexindent formatting");
  const path = "notes/été 中文.txt";
  await invoke("write_project_file", { projectRoot, path, content: "Première sauvegarde — 中文\n" });
  await invoke("write_project_file", { projectRoot, path, content: "Seconde sauvegarde — 中文\n" });
  const saved = await invoke("read_project_file", { projectRoot, path });
  if (saved !== "Seconde sauvegarde — 中文\n") throw new Error("Unicode document save round-trip failed");
  console.log("ok: the installed app saves and replaces a Unicode document");
  const callback = await session.run(`
    window.__latticeTerminalOutput = "";
    return window.__TAURI_INTERNALS__.transformCallback(raw => {
      const message = raw.message;
      if (Array.isArray(message) || message instanceof ArrayBuffer) {
        window.__latticeTerminalOutput += new TextDecoder().decode(new Uint8Array(message));
      }
    });
  `);
  const terminal = await invoke("terminal_open", { projectRoot, cols: 100, rows: 30, onOutput: `__CHANNEL__:${callback}` });
  try {
    await invoke("terminal_resize", { id: terminal.id, cols: 80, rows: 24 });
    // Write a file, instead of searching echoed command text in the output.
    await invoke("terminal_write", { id: terminal.id, data: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'terminal-proof.txt'), 'ConPTY works')\r" });
    const deadline = Date.now() + 30_000;
    let text;
    while (Date.now() < deadline) {
      text = await invoke("read_project_file", { projectRoot, path: "terminal-proof.txt" }).catch(() => null);
      if (text === "ConPTY works") break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (text !== "ConPTY works") throw new Error("PowerShell did not execute in the project folder");
    await waitFor("terminal output", "return window.__latticeTerminalOutput.length > 0;");
    console.log("ok: ConPTY PowerShell input, output, resize and project folder");
  } finally {
    await invoke("terminal_close", { id: terminal.id });
    await session.run("window.__TAURI_INTERNALS__.unregisterCallback(arguments[0]);", [callback]);
  }
  await stopMonitor();
  const consoles = JSON.parse(readFileSync(reportPath, "utf8").replace(/^\uFEFF/, ""));
  if (consoles.length) throw new Error(`Unexpected visible console windows: ${JSON.stringify(consoles)}`);
  console.log("ok: no visible console windows during startup, resizing, builds and terminal use");
  writeFileSync(join(artifacts, "windows.png"), Buffer.from(await session.screenshot(), "base64"));
  writeFileSync(join(artifacts, "result.txt"), "Installed Windows application: tutorial build, PDF rendering, rebuild, Unicode saves, PowerShell ConPTY and no external console windows during maximization passed.\n");
  console.log("windows e2e: every check passed");
} catch (error) {
  if (session) await saveEvidence(session, artifacts);
  throw error;
} finally {
  if (session) await session.end().catch(() => {});
  if (appProcess && appProcess.exitCode === null) appProcess.kill();
  await stopMonitor().catch(error => console.error(error.message));
}
