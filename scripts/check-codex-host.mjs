// Opt-in macOS smoke: node scripts/check-codex-host.mjs /absolute/path/to/codex
// Uses the staged spawn path, a disposable Codex home, and no model requests.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
assert.equal(process.platform, "darwin", "This smoke needs macOS Seatbelt");
const binary = process.argv[2];
assert.ok(binary?.startsWith("/"), "Pass an absolute Codex executable path");
const inside = process.argv[3];
if (!inside) {
  const fixture = mkdtempSync(join(tmpdir(), "lattice-codex-smoke-"));
  try {
    mkdirSync(join(fixture, "codex-home"));
    writeFileSync(join(fixture, "references.bib"), "original bibliography\n");
    const rust = readFileSync(join(root, "src-tauri/src/synara.rs"), "utf8");
    const profileSource = rust.match(/const BIBLIOGRAPHY_SANDBOX_PROFILE: &str = concat!\(([\s\S]*?)\n\);/)?.[1];
    assert.ok(profileSource, "Could not locate the host sandbox profile");
    const profile = [...profileSource.matchAll(/^\s*("(?:[^"\\]|\\.)*")/gm)].map((match) => JSON.parse(match[1])).join("");
    const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, script, binary, fixture], {
      stdio: "inherit", timeout: 45_000,
      env: { ...process.env, LATTICE_BIBLIOGRAPHY_SANDBOX: "1" },
    });
    assert.equal(result.status, 0, `Sandboxed smoke failed: ${result.error ?? result.signal ?? result.status}`);
    assert.equal(readFileSync(join(fixture, "references.bib"), "utf8"), "original bibliography\n");
    assert.equal(readFileSync(join(fixture, "paper.tex"), "utf8"), "allowed");
    console.log("PASS: real Codex initialize/thread/start/command/exec; inherited .bib denial; .tex writes; process exit.");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
} else {
  const bundle = readFileSync(join(root, "src-tauri/synara-runtime/server/dist/index.mjs"), "utf8");
  const start = bundle.indexOf("function spawnCodexAppServer(input) {");
  const end = bundle.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  const spawnCodex = runInNewContext(`${bundle.slice(start, end)}; spawnCodexAppServer`, {
    process,
    ACTIVE_AGENT_HOST_PROFILE: { id: "lattice" },
    spawnProcess: (command, args, options) => {
      assert.equal(command, binary, "Do not nest sandbox-exec inside the host sandbox");
      return spawn(command, args, options);
    },
  });
  const child = spawnCodex({ binaryPath: binary, cwd: inside, env: {
    PATH: process.env.PATH, HOME: inside, CODEX_HOME: join(inside, "codex-home"),
    TMPDIR: process.env.TMPDIR, LATTICE_BIBLIOGRAPHY_SANDBOX: "1",
  } });
  const pending = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const request of pending.values()) request.reject(new Error(`Codex exited: ${code}/${signal}`));
      resolve({ code, signal });
    });
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, 30_000);
  try {
    const initialized = await request("initialize", { clientInfo: { name: "lattice_desktop", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    assert.ok(initialized.userAgent);
    child.stdin.write('{"method":"initialized"}\n');
    const started = await request("thread/start", { cwd: inside, approvalPolicy: "never", sandbox: "danger-full-access" });
    assert.ok(started.thread.id);
    const exec = (command) => request("command/exec", { command: ["/bin/sh", "-c", command], cwd: inside, sandboxPolicy: { type: "dangerFullAccess" } });
    const denied = await exec("printf forbidden > references.bib");
    assert.notEqual(denied.exitCode, 0, "Codex must inherit the host .bib write denial");
    const allowed = await exec("printf allowed > paper.tex");
    assert.equal(allowed.exitCode, 0);
    child.stdin.end();
    const exit = await exited;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  } finally {
    clearTimeout(timer);
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
