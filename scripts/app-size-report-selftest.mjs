import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkAppSizeBudgets, createAppSizeReport } from "./app-size-report.mjs";

const workspace = await mkdtemp(path.join(os.tmpdir(), "app-size-report-"));
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));
await mkdir(path.join(workspace, "dist/assets"), { recursive: true });
await writeFile(path.join(workspace, "dist/assets/app.js"), "12345");
await writeFile(path.join(workspace, "dist/assets/style.css"), "123");
await writeFile(path.join(workspace, "dist/other.txt"), "1234567");
await writeFile(path.join(workspace, "dist/index.html"), `<!doctype html><html><head>
  <script src="/assets/app.js?v=1#x"></script>
  <link rel="modulepreload" href="assets/app.js#duplicate">
  <link href="/assets/style.css?theme=x" rel="stylesheet">
  <script src="https://example.test/external.js"></script>
</head><body></body></html>`);

let report = await createAppSizeReport(workspace);
assert.equal(report.eagerJsBytes, 5);
assert.equal(report.eagerCssBytes, 3);
assert.equal(report.distBytes, 8 + 7 + Buffer.byteLength(await (await import("node:fs/promises")).readFile(path.join(workspace, "dist/index.html"))));
assert.equal(report.synaraRuntimeBytes, null);
assert.equal(report.bundledNodeBytes, null);
assert.deepEqual(report.claudeAgentSdkExecutables, []);

const runtime = path.join(workspace, "src-tauri/synara-runtime");
await mkdir(path.join(runtime, "bin"), { recursive: true });
await mkdir(path.join(runtime, "server/dist"), { recursive: true });
await mkdir(path.join(runtime, "server/node_modules/@anthropic-ai/claude-agent-sdk-test"), { recursive: true });
await writeFile(path.join(runtime, "bin/node"), "node");
await writeFile(path.join(runtime, "server/dist/server.js"), "server");
await writeFile(path.join(runtime, "server/node_modules/pkg"), "mod");
await writeFile(path.join(runtime, "server/node_modules/@anthropic-ai/claude-agent-sdk-test/claude"), "claude");
await symlink(path.join(runtime, "bin/node"), path.join(runtime, "node-again"));
const outside = path.join(workspace, "outside");
await writeFile(outside, "do not count");
await symlink(outside, path.join(runtime, "outside-link"));

report = await createAppSizeReport(workspace);
assert.equal(report.bundledNodeBytes, 4);
assert.equal(report.synaraServerDistBytes, 6);
assert.equal(report.runtimeNodeModulesBytes, 9);
assert.equal(report.synaraRuntimeBytes, 19, "deduplicates internal symlinks and rejects external ones");
assert.deepEqual(report.claudeAgentSdkExecutables, [{
  path: "server/node_modules/@anthropic-ai/claude-agent-sdk-test/claude",
  bytes: 6,
}]);

await symlink(outside, path.join(workspace, "dist/assets/escape.js"));
await writeFile(path.join(workspace, "dist/index.html"), '<html><script src="/assets/escape.js"></script></html>');
await assert.rejects(createAppSizeReport(workspace), /escapes dist/);

await unlink(path.join(workspace, "dist/assets/escape.js"));
await writeFile(path.join(workspace, "dist/assets/app-hash.js"), "app");
await writeFile(path.join(workspace, "dist/assets/ui-hash.js"), "ui");
await writeFile(path.join(workspace, "dist/assets/provided-icons-hash.js"), "icons");
await writeFile(path.join(workspace, "dist/assets/rolldown-runtime-hash.js"), "runtime");
await writeFile(path.join(workspace, "dist/polyfills.js"), "polyfill");
await writeFile(path.join(workspace, "dist/index.html"), `<html><head>
  <script src="/assets/app-hash.js"></script>
  <link rel="modulepreload" href="/assets/ui-hash.js">
  <link rel="modulepreload" href="/assets/provided-icons-hash.js">
  <link rel="modulepreload" href="/assets/rolldown-runtime-hash.js">
</head><body><script src="/polyfills.js"></script></body></html>`);
const guard = await checkAppSizeBudgets(workspace);
assert.equal(guard.rolldownRuntimeBytes, 7);

await writeFile(path.join(workspace, "dist/assets/rolldown-runtime-hash.js"), Buffer.alloc(4_097));
await assert.rejects(checkAppSizeBudgets(workspace), /rolldown-runtime.*budget/);
await writeFile(path.join(workspace, "dist/assets/rolldown-runtime-hash.js"), "runtime");
await writeFile(path.join(workspace, "dist/assets/app-hash.js"), Buffer.alloc(1_500_000));
await assert.rejects(checkAppSizeBudgets(workspace), /Eager JavaScript.*budget/);

console.log("app-size-report self-test passed");
