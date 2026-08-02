#!/usr/bin/env node
/**
 * One-shot migration from the raw theme palette to the semantic token layer.
 *
 * `styles/theme.css` stays the single place raw colors are declared, and
 * `styles/foundations.css` stays the single place semantic roles are mapped
 * onto them. Everything else consumes the semantic role. This script rewrites
 * the feature stylesheets that predate that split.
 *
 * Kept in `scripts/` rather than run inline so the mapping is reviewable and the
 * same rewrite can be replayed on a branch that missed it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const MAP = {
  bg: "surface-app",
  panel: "surface-panel",
  "panel-strong": "surface-panel-raised",
  "chrome-surface": "surface-chrome",
  sidebar: "surface-sidebar",
  "side-surface": "surface-input",
  line: "border-subtle",
  "line-strong": "border-strong",
  text: "text-primary",
  muted: "text-secondary",
  faint: "text-tertiary",
  "chrome-text": "text-chrome",
  accent: "control-active",
  "accent-soft": "control-active-soft",
  "accent-contrast": "control-active-contrast",
  danger: "status-danger",
  success: "status-success",
  warning: "status-warning",
};

/** Files that own the two ends of the mapping and must not be rewritten. */
const EXCLUDED = new Set([
  "src/styles/foundations.css",
  "src/styles/theme.css",
  "src/index.css",
]);

const files = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(css|tsx|ts)$/.test(file))
  .filter((file) => !EXCLUDED.has(file));

let changedFiles = 0;
let changedRefs = 0;

for (const file of files) {
  const absolute = path.join(ROOT, file);
  const original = readFileSync(absolute, "utf8");

  const migrated = original
    .split("\n")
    .map((line) => {
      return line.replace(/var\(--([a-z-]+)\)/g, (match, name) => {
        const replacement = MAP[name];
        if (!replacement) return match;
        changedRefs += 1;
        return `var(--${replacement})`;
      });
    })
    .join("\n");

  if (migrated !== original) {
    writeFileSync(absolute, migrated);
    changedFiles += 1;
  }
}

console.log(`rewrote ${changedRefs} references across ${changedFiles} files`);
