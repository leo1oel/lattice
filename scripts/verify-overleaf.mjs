#!/usr/bin/env node
/**
 * Checks the Overleaf bridge against the real overleaf.com, not a mock.
 *
 * The unit tests prove the protocol is implemented; only this proves it is the
 * protocol Overleaf actually speaks. Both bugs that made live editing silently
 * fall back to syncing — a rejected `meta.source`, and an acknowledgement that
 * carries no operation — were invisible to the mock and obvious here.
 *
 * It uses the session the app already stored, and edits nothing except the
 * document you name (one character inserted, then deleted, leaving the text
 * byte-identical).
 *
 *   node scripts/verify-overleaf.mjs "<project folder>" ["<document name>"]
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [root, doc] = process.argv.slice(2);
if (!root) {
  console.error('Usage: node scripts/verify-overleaf.mjs "<project folder>" ["<document>"]');
  process.exit(2);
}

try {
  const state = JSON.parse(readFileSync(join(root, ".research", "overleaf.json"), "utf8"));
  console.log(`Project: ${state.projectName} (${state.projectId}) on ${state.host}\n`);
} catch {
  console.error(`${root} is not linked to an Overleaf project.`);
  process.exit(2);
}

const tests = ["connects_to_the_real_overleaf"];
if (doc) tests.push("edits_a_document_through_the_real_overleaf");
else console.log("No document named, so the editing round trip is skipped.\n");

for (const test of tests) {
  const result = spawnSync(
    "cargo",
    [
      "test", "--manifest-path", "src-tauri/Cargo.toml",
      `overleaf_rt::tests::${test}`, "--", "--ignored", "--nocapture",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, OVERLEAF_E2E_PROJECT: root, OVERLEAF_E2E_DOC: doc ?? "" },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
