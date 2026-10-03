/**
 * Tests exercise behaviour; they do not grep source.
 *
 * A test that reads a repository file as text and asserts a string is in it
 * passes as long as the string survives — a renamed call, a dead branch or a
 * comment all satisfy it — and reviewers kept rejecting such tests. This guard
 * fails when a test file under `src/` or `tools/` reads a file off disk
 * (`readFile`/`readFileSync` from `fs` or `fs/promises`) or imports one with
 * Vite's `?raw` suffix, unless it is listed below with what it guards. The
 * entries are deliberate: repo-level contracts with no runtime to drive, or
 * stylesheets and fixtures Vitest would otherwise hand over empty. The list
 * only shrinks — an entry that no longer reads a file fails too.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ALLOWED = new Set([
  "src/app/native-locale.test.ts", // menu-bar labels shared with Rust through a JSON fixture
  "src/app/window-layout.test.ts", // minimum width vs tauri.conf.json; narrow-pane CSS in jsdom
  "src/platform/tauri-security-config.test.ts", // CSP, capabilities, packaging: Rust, JSON, scripts
  "src/platform/polyfills.test.ts", // public/polyfills.js loads from index.html before any module
  "src/platform/clean-room-guard.test.ts", // every package.json's dependencies and license
  "src/platform/source-text-test-guard.test.ts", // this guard
  "src/pdf/pdf-viewer.test.ts", // viewer stylesheet applied in jsdom (Vitest empties CSS imports)
  "src/pdf/pdf-text-layer-selection.test.ts", // text-layer selection stylesheet, likewise
  "src/styles/tokens.test.ts", // the design-token contract (CLAUDE.md)
  "src/styles/surfaces.test.ts", // shared surfaces owned by one stylesheet
  "src/components/ui/activity-icons.test.tsx", // busy reload buttons share one surface
  "src/components/ui/chrome-primitives.test.tsx", // primitive press and menu geometry in chrome.css
  "src/components/ui/popup-motion.test.ts", // every popup wrapper uses the one popup-motion owner
  "src/trellis/trellis-header-tools.test.tsx", // build-result motion under the reduced-motion stylesheet
  "src/trellis/trellis-titlebar.test.tsx", // narrow title-bar containment and shed order, parsed into jsdom's CSSOM
  "src/editor/board/board-store.test.ts", // the bundled tutorial board loads
  "src/editor/board/board-asset-urls.test.ts", // the bundled fonts ship their OFL text
  "src/editor/spreadsheet/spreadsheet-yjs.test.ts", // the bundled tutorial workbook loads
  "src/editor/spreadsheet/spreadsheet-xlsx.test.ts", // the tutorial workbook exports to xlsx
  "src/editor/presentation/open-slide-skill.test.ts", // the embedded skill is Markdown for the agent
]);

const FS_IMPORT = /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']|\bimport\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/;
const FS_READ = /\breadFile(?:Sync)?\b/;
const RAW_IMPORT = /["'][^"'\n]*\?raw["']/;

/** Test files under src/ and tools/ that Git tracks or would add. */
function testFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "tools"], { encoding: "utf8" });
  return output.split("\0").filter((path) => /\.test\.tsx?$/.test(path));
}

function readsSourceText(path: string): boolean {
  const source = readFileSync(path, "utf8");
  return (FS_IMPORT.test(source) && FS_READ.test(source)) || RAW_IMPORT.test(source);
}

describe("source-text test guard", () => {
  const readers = testFiles().filter(readsSourceText);

  it("finds no test outside the allowlist reading a source file as text", () => {
    expect(
      readers.filter((path) => !ALLOWED.has(path)),
      "These tests read a repository file as text (fs readFile/readFileSync or a `?raw` import). " +
        "Test the behaviour instead: render it, call it, or drive it. If the file is a deliberate " +
        "repo-level guard, add it to ALLOWED in src/platform/source-text-test-guard.test.ts with what it guards.",
    ).toEqual([]);
  });

  it("keeps no allowlist entry for a test that no longer reads source text", () => {
    expect(
      [...ALLOWED].filter((path) => !readers.includes(path)),
      "Remove these entries from ALLOWED: the files are gone or no longer read source text.",
    ).toEqual([]);
  });
});
