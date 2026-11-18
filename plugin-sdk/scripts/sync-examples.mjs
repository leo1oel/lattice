#!/usr/bin/env node
// Each example plugin carries its own copy of lattice-plugin.mjs and the
// SDK's licence, because a sandboxed plugin can read only its own folder.
// This copies them in; `--check` fails when a copy drifted instead.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const examples = join(root, "examples/plugins");
const shared = ["lattice-plugin.mjs", "LICENSE"];

export function drifted() {
  const stale = [];
  for (const plugin of readdirSync(examples)) {
    for (const file of shared) {
      const want = readFileSync(join(root, "plugin-sdk", file), "utf8");
      let have = null;
      try {
        have = readFileSync(join(examples, plugin, file), "utf8");
      } catch {}
      if (have !== want) stale.push({ path: join(examples, plugin, file), want });
    }
  }
  return stale;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stale = drifted();
  if (process.argv.includes("--check")) {
    for (const { path } of stale) console.error(`stale: ${path} (run node plugin-sdk/scripts/sync-examples.mjs)`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const { path, want } of stale) writeFileSync(path, want);
}
