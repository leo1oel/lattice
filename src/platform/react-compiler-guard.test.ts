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
 * grow the skipped set. Every other source file is held to BASELINE, or to
 * zero when it is not listed there. A file below its pin fails too, so a
 * cleared bailout lowers the pin in the same change; never raise one without
 * a comment explaining why.
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
  // Lattice Shares branches went. The open documents, the project lifecycle,
  // the project tree, SyncTeX navigation and the LaTeX structure then moved
  // into the hooks below, taking every try/finally and inline import() with
  // them, so the compiler now gets as far as App's manual memoization: the 11
  // left are dependency lists it cannot preserve, one report per callback.
  "src/App.tsx": 11,
  // Extracted out of App.tsx. They inherit its try/finally bailouts rather than
  // adding new ones, but they need their own ceilings or those bailouts leave
  // the guard's field of view entirely.
  "src/app/use-overleaf-workspace.ts": 1,
  "src/app/use-build-pipeline.ts": 4,
  "src/app/use-reference-import.ts": 2,
  "src/app/use-editor-comments.ts": 0,
  "src/app/use-tex-setup.ts": 1,
  // The store behind every editor surface, and the project lifecycle around
  // it: both compile fully, so App's typing renders run one memo cache for
  // them rather than a hook per command.
  "src/app/use-open-documents.ts": 0,
  "src/app/use-project-lifecycle.ts": 0,
  "src/app/use-project-tree.ts": 0,
  "src/app/use-synctex-navigation.ts": 0,
  "src/app/use-latex-structure.ts": 0,
  "src/app/use-canvas-requests.ts": 0,
  "src/app/use-project-search.ts": 0,
  "src/app/use-tool-drawers.ts": 0,
  "src/app/app-overleaf-drawer.tsx": 0,
  "src/app/app-editor-panels.tsx": 0,
  "src/app/app-history-drawers.tsx": 0,
  "src/app/app-project-dialogs.tsx": 0,
  "src/app/app-search-dialogs.tsx": 0,
  "src/app/app-titlebar.tsx": 0,
  "src/trellis/trellis-panel-actions.tsx": 0,
  "src/canvas/document-canvas.tsx": 1,
  // The clean-room engine's editor keeps its mutable session in effects and
  // editor storage, so it compiles fully; pinned so it stays that way.
  "src/editor/markdown/engine/lattice-visual-editor.tsx": 0,
  // Split out of the viewer, which had 5. Each remaining one is a tagged
  // template or a preserved memo, not a ref write; the viewer itself compiles.
  "src/pdf/pdf-viewer.tsx": 0,
  "src/pdf/use-pdf-document.ts": 0,
  "src/pdf/use-pdf-view.ts": 1,
  // Lists that scroll: the .bib reference list was skipped whole (a catch
  // binding in a closure) and re-rendered its toolbar on every scrolled
  // frame; the Papers list's rows rely on compiling to skip unchanged rows.
  "src/papers/bib-visual-editor.tsx": 0,
  "src/project/paper-library.tsx": 0,
  "src/project/paper-list-window.ts": 0,
  // Cleared August 2026 by moving render-phase ref writes into every-commit
  // layout effects (model: src/editor/codemirror-host.tsx). Pinned at 0 so the
  // pattern cannot creep back.
  "src/project/project-find-dialog.tsx": 0,
  "src/telemetry/app-updater.tsx": 1,
};

/**
 * The bailouts every other source file had when the guard widened to the
 * whole of src/ (2026-10). Not hot paths, so they are a pin rather than a
 * target: the list only shrinks, and a file missing from it must compile.
 */
const BASELINE: Record<string, number> = {
  "src/app/use-project-state.ts": 2,
  "src/build/tex-setup-wizard.tsx": 3,
  "src/build/use-compile-repair.ts": 5,
  "src/canvas/codemirror-scrollbar.tsx": 1,
  "src/canvas/use-markdown-mode-handoff.ts": 1,
  "src/canvas/use-markdown-split-scroll.ts": 1,
  "src/canvas/use-paper-pdf.ts": 1,
  "src/components/ui/confirm-action-dialog.tsx": 1,
  "src/components/ui/exit-picture.ts": 1,
  "src/components/ui/fluid-hover-surface.tsx": 1,
  "src/components/ui/search-picker-dialog.tsx": 1,
  "src/components/ui/use-fluid-hover.ts": 1,
  "src/editor/codemirror-host.tsx": 1,
  "src/editor/markdown/document-heading-rail.tsx": 2,
  "src/editor/markdown/engine/chrome/block-controls.tsx": 1,
  "src/editor/markdown/engine/chrome/suggestion-menu.tsx": 2,
  "src/editor/markdown/engine/views/code-block-view.tsx": 2,
  "src/editor/markdown/engine/views/mermaid-preview.tsx": 1,
  "src/editor/presentation/open-slide-workspace.tsx": 3,
  "src/editor/spreadsheet/spreadsheet-editor.tsx": 6,
  "src/history/conflict-resolver.tsx": 1,
  "src/history/history-drawer.tsx": 1,
  "src/history/use-git-versions.ts": 2,
  "src/onboarding/guided-tour.tsx": 1,
  "src/overleaf/overleaf-connect.tsx": 3,
  "src/overleaf/overleaf-review.tsx": 1,
  "src/overleaf/use-overleaf-chat.ts": 1,
  "src/overleaf/use-overleaf-history.ts": 1,
  "src/overleaf/use-overleaf-project-snapshot.ts": 1,
  "src/overleaf/use-overleaf-realtime.ts": 3,
  "src/overleaf/use-overleaf-track-changes.ts": 1,
  "src/papers/bib-entry-dialog.tsx": 1,
  "src/papers/bibliography-audit.tsx": 1,
  "src/papers/literature-discovery-panel.tsx": 2,
  "src/project/manuscript-checklist.tsx": 1,
  "src/project/project-file-tree.tsx": 2,
  "src/project/project-tree-files.ts": 1,
  "src/settings/literature-settings.tsx": 1,
  "src/settings/use-appearance.ts": 1,
  "src/trellis/trellis-header-tools.tsx": 1,
  "src/trellis/trellis-workspace.tsx": 5,
};

/** Every source file the build hands the compiler: src/, minus tests and declarations. */
function sourceFiles(repo: string): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src"], { cwd: repo, encoding: "utf8" });
  return output.split("\0").filter((file) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file));
}

describe("react compiler bailout guard", () => {
  it("keeps every source file at its bailout pin", { timeout: 120_000 }, () => {
    const repo = path.resolve(__dirname, "../..");
    const files = sourceFiles(repo);
    const pin = (file: string) => CEILINGS[file] ?? BASELINE[file] ?? 0;
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        ["scripts/react-compiler-report.mjs", ...files],
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
    const over = files
      .filter((file) => (counts.get(file) ?? 0) > pin(file))
      .map((file) => `${file}: ${counts.get(file)} > ${pin(file)}`);
    expect(over, `bailouts above their pin (run: node scripts/react-compiler-report.mjs <file>)\n${output}`).toEqual([]);
    const under = files
      .filter((file) => (counts.get(file) ?? 0) < pin(file))
      .map((file) => `${file}: ${counts.get(file)} < ${pin(file)}`);
    expect(under, "bailouts cleared: lower these pins in CEILINGS or BASELINE to the new count").toEqual([]);
    // The report must actually have covered every source file, and every pin
    // must name one.
    expect([...counts.keys()].sort()).toEqual([...files].sort());
    expect([...Object.keys(CEILINGS), ...Object.keys(BASELINE)].filter((file) => !files.includes(file))).toEqual([]);
  });
});
