import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * React Compiler bailout guard.
 *
 * The compiler silently skips any function it cannot prove safe, and for a
 * long time it skipped App, DocumentCanvas, and the visual markdown editor —
 * the components whose re-render cost dominates typing latency — without
 * anyone noticing. This test runs scripts/react-compiler-report.mjs (the same
 * Babel plugin the build uses) and pins a per-file ceiling, so a new
 * try/finally, render-phase ref write, or inline import() cannot silently
 * grow the skipped set. Lower a ceiling when you clear bailouts; never raise
 * one without a comment explaining why.
 *
 * Current ceilings (2026-08): editor-tabs is fully compiled. The rest are a
 * staged cleanup — App.tsx needs its ~35 try/finally callback bodies hoisted
 * to module helpers, DocumentCanvas is skipped wholesale because its
 * intentional-stability memos carry react-hooks/exhaustive-deps disables
 * (that pattern conflicts with compiler memoization and needs its own
 * design), and the remaining files have render-phase ref writes pending a
 * case-by-case audit. See docs/performance.md.
 */
const CEILINGS: Record<string, number> = {
  // 36, not 35: the command palette's `import("./build/texlab-language")` moved
  // back into App with the palette itself, so the bailout the compiler already
  // reported for that expression is now counted here instead of in an overlay
  // file. No new pattern was introduced.
  "src/App.tsx": 36,
  // Extracted out of App.tsx. They inherit its try/finally bailouts rather than
  // adding new ones, but they need their own ceilings or those bailouts leave
  // the guard's field of view entirely.
  "src/app/use-overleaf-workspace.ts": 1,
  "src/app/use-collab-v2-session.ts": 10,
  "src/app/app-collab-surfaces.tsx": 0,
  "src/app/app-editor-panels.tsx": 1,
  "src/app/app-history-drawers.tsx": 1,
  "src/app/app-onboarding-tour.tsx": 0,
  "src/app/app-project-dialogs.tsx": 0,
  "src/app/app-search-dialogs.tsx": 3,
  "src/app/app-titlebar.tsx": 0,
  "src/app/app-workspace-sidebar.tsx": 0,
  "src/canvas/document-canvas.tsx": 3,
  "src/editor/markdown/visual-markdown-editor.tsx": 3,
  "src/canvas/editor-tabs.tsx": 0,
  "src/pdf/pdf-viewer.tsx": 5,
  // Cleared August 2026 by moving render-phase ref writes into every-commit
  // layout effects (model: src/editor/codemirror-host.tsx). Pinned at 0 so the
  // pattern cannot creep back.
  "src/app/use-panel-layout.ts": 0,
  "src/project/project-find-dialog.tsx": 0,
  "src/telemetry/app-updater.tsx": 1,
};

describe("react compiler bailout guard", () => {
  it("keeps hot components at or below their bailout ceilings", { timeout: 120_000 }, () => {
    const repo = path.resolve(__dirname, "../..");
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        ["scripts/react-compiler-report.mjs", ...Object.keys(CEILINGS)],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
    } catch (error) {
      // The report exits 1 whenever any bailouts exist; the ceilings below
      // decide whether that is acceptable.
      output = String((error as { stdout?: string | Buffer }).stdout ?? "");
    }
    const counts = new Map<string, number>();
    for (const line of output.split("\n")) {
      const match = line.match(/^(\S+): (\d+) bailout/);
      if (match) counts.set(match[1], Number(match[2]));
    }
    const over = Object.entries(CEILINGS)
      .filter(([file, ceiling]) => (counts.get(file) ?? 0) > ceiling)
      .map(([file, ceiling]) => `${file}: ${counts.get(file)} > ${ceiling}`);
    expect(over, `bailouts above ceiling (run: node scripts/react-compiler-report.mjs)\n${output}`).toEqual([]);
    // The report must actually have covered every guarded file.
    expect([...counts.keys()].sort()).toEqual(Object.keys(CEILINGS).sort());
  });
});
