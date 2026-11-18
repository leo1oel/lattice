#!/usr/bin/env node
// Pack a plugin folder as the .zip Settings › Plugins › Install from URL
// takes, and print its SHA-256 to publish beside it:
//   node plugin-sdk/scripts/pack-plugin.mjs examples/plugins/bib-check dist/bib-check-0.1.0.zip
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [folder, out] = process.argv.slice(2);
if (!folder || !out) {
  console.error("usage: pack-plugin.mjs <plugin folder> <out.zip>");
  process.exit(2);
}
const target = resolve(out);
mkdirSync(dirname(target), { recursive: true });
rmSync(target, { force: true });
execFileSync("zip", ["-qr", "-X", target, ".", "-x", "*.test.mjs", "-x", ".*"], { cwd: resolve(folder) });
const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");
console.log(`${target}\nsha256 ${sha256}`);
