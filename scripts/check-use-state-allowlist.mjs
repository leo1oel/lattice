#!/usr/bin/env node
// The useState allowlist in .oxlintrc.json (the override that turns
// `lattice/no-use-state` off) only shrinks.
//
//   node scripts/check-use-state-allowlist.mjs
//
// Fails when an entry's file no longer uses useState (delete the entry), and,
// when the staged .oxlintrc.json differs from HEAD's, when it lists a file
// HEAD's did not: new code uses useReducer or a store instead. `pnpm lint`
// runs the first check; the lint-staged pre-commit hook runs both, as it does
// the file-size ratchet.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./lib/util.mjs";

const RULE = "lattice/no-use-state";

// .oxlintrc.json is JSONC; drop comments outside strings, then trailing commas.
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function allowlist(text) {
  const overrides = parseJsonc(text).overrides ?? [];
  return overrides.find((o) => o.rules?.[RULE] === "off")?.files ?? null;
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const current = git("show", ":.oxlintrc.json") ?? readFileSync(join(projectRoot, ".oxlintrc.json"), "utf8");
const files = allowlist(current);
if (!files) {
  console.error(`check-use-state-allowlist: no override in .oxlintrc.json turns ${RULE} off.`);
  process.exit(1);
}

const problems = [];
const usesUseState = /\buseState\b/;
for (const file of files) {
  const path = join(projectRoot, file);
  if (!existsSync(path) || !usesUseState.test(readFileSync(path, "utf8"))) {
    problems.push(`${file} no longer uses useState: delete it from the allowlist.`);
  }
}

const base = git("show", "HEAD:.oxlintrc.json");
const baseFiles = base === null ? null : allowlist(base);
if (baseFiles) {
  const known = new Set(baseFiles);
  for (const file of files) {
    if (!known.has(file)) {
      problems.push(`${file} was added to the allowlist: use useReducer or a store instead (CODING_STANDARDS.md, "Component state").`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-use-state-allowlist: ${problem}`);
  process.exit(1);
}
