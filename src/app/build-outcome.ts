import type { BuildResult, BuildStep } from "../app-types";
import { sortDiagnostics, summarizeDiagnostics, type CompileDiagnostic, type DiagnosticCounts } from "../build/compile-diagnostics";

/**
 * How the last build ended, as the .tex panels' Build button reports it: its
 * time when it succeeded, what its diagnostics counted, the document it
 * compiled (when the backend said) and when it finished. The pipeline holds
 * null when there is nothing to report (no build yet, a new project, or a
 * build the writer stopped).
 */
export type BuildOutcome = ({ status: "succeeded"; seconds: number } | { status: "failed" }) & {
  counts: DiagnosticCounts;
  rootDocument: string | null;
  finishedAt: number;
  /** The passes it ran, how many pages it wrote and whether SyncTeX came with them (see BuildResult). */
  steps: BuildStep[];
  pages: number | null;
  synctex: boolean | null;
  /** The problem the writer meets first (an error before a warning), for the Build button's sequence. */
  issue: CompileDiagnostic | null;
};

/** The outcome a finished pass reports; null for one the writer stopped. */
export function buildOutcome(result: BuildResult, cancelled: boolean): BuildOutcome | null {
  const issue = sortDiagnostics(result.diagnostics).find((item) => item.level === "error" || item.level === "warning") ?? null;
  const report = {
    counts: summarizeDiagnostics(result.diagnostics),
    rootDocument: result.rootDocument || null,
    finishedAt: Date.now(),
    steps: result.steps,
    pages: result.pages,
    synctex: result.synctex,
    issue,
  };
  return result.success
    ? { status: "succeeded", seconds: result.durationMs / 1000, ...report }
    : cancelled ? null : { status: "failed", ...report };
}

/** The outcome of a build the backend refused outright: no passes, no diagnostics. */
export function rejectedBuildOutcome(): BuildOutcome {
  return {
    status: "failed", counts: { error: 0, warning: 0, info: 0 }, rootDocument: null, finishedAt: Date.now(),
    steps: [], pages: null, synctex: null, issue: null,
  };
}
