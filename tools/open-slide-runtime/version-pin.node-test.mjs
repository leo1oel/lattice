import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

/**
 * Start the runtime the way the host's supervisor does (a managed shadow root,
 * control token and Vite cache root in the environment) and return the first
 * stdout line parsed: the readiness handshake the supervisor validates.
 */
async function readinessHandshake() {
  const root = await mkdtemp(path.join(tmpdir(), "lattice-open-slide-pin-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      OPEN_SLIDE_SHADOW_ROOT: root,
      OPEN_SLIDE_CONTROL_TOKEN: "pin-test-control-token",
      OPEN_SLIDE_CACHE_ROOT: path.join(root, ".vite-cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no readiness line within 60 s: ${stderr}`)), 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const end = stdout.indexOf("\n");
        if (end >= 0) {
          clearTimeout(timer);
          resolve(stdout.slice(0, end));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code} before its readiness line: ${stderr}`));
      });
    });
    return JSON.parse(line);
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}

// The host refuses a runtime whose handshake reports another version than the
// one it was built against (presentation.rs pins the supervisor side against
// this same manifest), so the running server must report the exact pin.
test("reports the exact pinned Open Slide version in the readiness handshake", async () => {
  const [manifest, installed, handshake] = await Promise.all([
    read("./package.json"),
    read("./node_modules/@open-slide/core/package.json"),
    readinessHandshake(),
  ]);
  const version = JSON.parse(manifest).dependencies["@open-slide/core"];
  assert.equal(JSON.parse(installed).version, version);
  assert.equal(handshake.ready, true);
  assert.equal(handshake.controlToken, "pin-test-control-token");
  assert.equal(handshake.version, version);
});
