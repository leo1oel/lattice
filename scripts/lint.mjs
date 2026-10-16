#!/usr/bin/env node
// `pnpm lint`: Oxlint with a warning cap that only moves down.
//
//   node scripts/lint.mjs --max-warnings <cap> <paths…>
//
// The cap in package.json's `lint` script is a debt ratchet. Oxlint itself
// fails above it; this wrapper also fails below it, naming the new count, so
// the change that removes warnings is the one that lowers the cap and no
// later change can spend the slack on new ones.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { projectRoot } from "./lib/util.mjs";

const args = process.argv.slice(2);
const capIndex = args.indexOf("--max-warnings");
const cap = Number(args[capIndex + 1]);
if (capIndex < 0 || !Number.isInteger(cap)) {
  console.error("usage: node scripts/lint.mjs --max-warnings <cap> <paths…>");
  process.exit(2);
}

// The unix format prints one `path:line:col: message [Severity/rule]` line per
// diagnostic and a `N problems` summary, so the count is read off the same
// output the reader sees, and no second lint pass is needed.
const oxlint = join(projectRoot, "node_modules/.bin/oxlint");
const result = spawnSync(oxlint, ["--format", "unix", ...args], {
  cwd: projectRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
if (result.status !== 0) process.exit(result.status ?? 1);

const warnings = result.stdout.split("\n").filter((line) => /\[Warning\/[^\]]*\]$/.test(line)).length;
if (warnings < cap) {
  console.error(
    `lint: ${warnings} warnings, below the cap of ${cap}. Lower the cap to ${warnings} in package.json's \`lint\` script.`,
  );
  process.exit(1);
}
