// Drive the installed Windows executable through its real WebView2 IPC.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { webDriver, startSession, runChecks, saveEvidence } from "./linux-e2e.mjs";

const { values } = parseArgs({ options: {
  app: { type: "string" }, driver: { type: "string", default: "http://127.0.0.1:4444" },
  artifacts: { type: "string", default: ".tmp/windows-e2e" },
} });
if (!values.app) throw new Error("Pass --app with the installed Lattice executable.");
const driver = webDriver(values.driver);
const session = await startSession(driver, resolve(values.app));
const artifacts = resolve(values.artifacts);
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
  await runChecks(session, console.log, "Windows");
  const project = await invoke("initial_project");
  if (!project?.root) throw new Error("The tutorial project is not bound to the window");
  const projectRoot = project.root;
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
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "windows.png"), Buffer.from(await session.screenshot(), "base64"));
  writeFileSync(join(artifacts, "result.txt"), "Installed Windows application: tutorial build, PDF rendering, rebuild, Unicode saves, PowerShell ConPTY passed.\n");
  console.log("windows e2e: every check passed");
} catch (error) {
  await saveEvidence(session, artifacts);
  throw error;
} finally {
  await session.end().catch(() => {});
}
