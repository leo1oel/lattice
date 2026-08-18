#!/usr/bin/env node
/**
 * Report React Compiler bailouts for the app's hottest components.
 *
 * The compiler silently skips any function it cannot prove safe (see the
 * comment in vite.config.ts), which for a long time included App,
 * DocumentCanvas, and the visual markdown editor — the exact components whose
 * re-render cost dominates typing latency. This script runs the same Babel
 * plugin the build uses and prints every CompileError with its location, so
 * bailouts are visible instead of silent. `react-compiler-guard.test.ts`
 * wires it into the test suite to keep the hot files at zero bailouts.
 *
 * Usage: node scripts/react-compiler-report.mjs [files...]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// @babel/core is a transitive dep (of @vitejs/plugin-react) under pnpm, so
// resolve it from the package that declares it — via the real path, since the
// hoisted entry is a symlink and module lookup walks the physical tree.
const require = createRequire(import.meta.url);
const pluginReactRequire = createRequire(
  path.join(fs.realpathSync(path.join(REPO, "node_modules/@vitejs/plugin-react")), "package.json"),
);
const { transformFileSync } = pluginReactRequire("@babel/core");
const reactCompiler = require("babel-plugin-react-compiler");

export const GUARDED_FILES = [
  "src/App.tsx",
  "src/canvas/document-canvas.tsx",
  "src/editor/markdown/visual-markdown-editor.tsx",
  "src/canvas/editor-tabs.tsx",
  "src/pdf/pdf-viewer.tsx",
];

/**
 * @param {string} relative repo-relative file path
 * @returns {{ fn: string; line: number; reason: string }[]}
 */
export function compileErrors(relative) {
  const events = [];
  transformFileSync(path.join(REPO, relative), {
    configFile: false,
    babelrc: false,
    // Same shape as @vitejs/plugin-react: the compiler runs over the raw TSX
    // AST (parser-level typescript/jsx support, no TS-stripping preset).
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [[reactCompiler, {
      target: "19",
      logger: { logEvent: (_filename, event) => events.push(event) },
    }]],
    code: false,
    ast: false,
  });
  return events
    .filter((event) => event.kind === "CompileError")
    .map((event) => ({
      fn: event.fnName ?? "(anonymous)",
      line: event.fnLoc?.start?.line ?? 0,
      at: event.detail?.loc?.start?.line
        ?? event.detail?.options?.loc?.start?.line
        ?? event.detail?.details?.[0]?.loc?.start?.line
        ?? 0,
      reason: String(
        event.detail?.reason
        ?? event.detail?.options?.reason
        ?? event.detail?.description
        ?? "unknown",
      ),
    }));
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : GUARDED_FILES;
  let total = 0;
  for (const file of files) {
    const errors = compileErrors(file);
    total += errors.length;
    console.log(`${file}: ${errors.length} bailout(s)`);
    for (const error of errors) {
      console.log(`  L${error.line} ${error.fn} (at L${error.at}): ${error.reason}`);
    }
  }
  process.exitCode = total > 0 ? 1 : 0;
}
