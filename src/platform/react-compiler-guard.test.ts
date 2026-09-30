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
 * Current ceilings (2026-08): the rest are a
 * staged cleanup — App.tsx needs its ~35 try/finally callback bodies hoisted
 * to module helpers, DocumentCanvas is skipped wholesale because its
 * intentional-stability memos carry react-hooks/exhaustive-deps disables
 * (that pattern conflicts with compiler memoization and needs its own
 * design), and the remaining files have render-phase ref writes pending a
 * case-by-case audit. See docs/performance.md.
 */
const CEILINGS: Record<string, number> = {
  // 22 after the build pipeline, reference import, editor comments and TeX
  // setup moved into src/app hooks, which carry the rest below; 17 once the
  // Lattice Shares branches went.
  "src/App.tsx": 17,
  // Extracted out of App.tsx. They inherit its try/finally bailouts rather than
  // adding new ones, but they need their own ceilings or those bailouts leave
  // the guard's field of view entirely.
  "src/app/use-overleaf-workspace.ts": 1,
  "src/app/use-build-pipeline.ts": 4,
  "src/app/use-reference-import.ts": 2,
  "src/app/use-editor-comments.ts": 0,
  "src/app/use-tex-setup.ts": 1,
  "src/app/app-overleaf-drawer.tsx": 0,
  "src/app/app-editor-panels.tsx": 0,
  "src/app/app-history-drawers.tsx": 0,
  "src/app/app-project-dialogs.tsx": 0,
  "src/app/app-search-dialogs.tsx": 2,
  "src/app/app-titlebar.tsx": 0,
  "src/trellis/trellis-panel-actions.tsx": 0,
  "src/canvas/document-canvas.tsx": 1,
  // The clean-room engine's editor keeps its mutable session in effects and
  // editor storage, so it compiles fully; pinned so it stays that way.
  "src/editor/markdown/engine/lattice-visual-editor.tsx": 0,
  // Split out of the viewer, which had 5. Each remaining one is a tagged
  // template or a preserved memo, not a ref write; the viewer itself compiles.
  "src/pdf/pdf-viewer.tsx": 0,
  "src/pdf/use-pdf-document.ts": 1,
  "src/pdf/use-pdf-view.ts": 1,
  // Cleared August 2026 by moving render-phase ref writes into every-commit
  // layout effects (model: src/editor/codemirror-host.tsx). Pinned at 0 so the
  // pattern cannot creep back.
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
