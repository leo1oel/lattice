import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("reports the exact pinned Open Slide version in the readiness handshake", async () => {
  const [manifest, server, installed, supervisor] = await Promise.all([
    read("./package.json"),
    read("./server.mjs"),
    read("./node_modules/@open-slide/core/package.json"),
    read("../../src-tauri/lattice-core/src/presentation.rs"),
  ]);
  const version = JSON.parse(manifest).dependencies["@open-slide/core"];
  assert.equal(JSON.parse(installed).version, version);
  assert.equal(server.match(/const VERSION = "([^"]+)";/)?.[1], version);
  assert.equal(supervisor.match(/const VERSION: &str = "([^"]+)";/)?.[1], version);
});
