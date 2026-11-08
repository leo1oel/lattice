import type { BuildResult, BuildStep } from "../app-types";
import { sortDiagnostics, summarizeDiagnostics, type CompileDiagnostic, type DiagnosticCounts } from "../build/compile-diagnostics";

/**
 * How the last build ended, as the .tex panels' Build button reports it: its
 * time when it succeeded, what its diagnostics counted, the document it
 * compiled (when the backend said) and when it finished. The pipeline holds
 * null when there is nothing to report (no build yet, a new project, or a
 * build the writer stopped).
 */
export type BuildOutcome = ({ status: "succeeded"; seconds: number } | {
  status: "failed";
  /** TeX carried on past the errors and the PDF on screen is this build's, errors and all. */
  wrotePdf: boolean;
}) & {
  counts: DiagnosticCounts;
  rootDocument: string | null;
  finishedAt: number;
  /** The passes it ran, how many pages it wrote and whether SyncTeX came with them (see BuildResult). */
  steps: BuildStep[];
  pages: number | null;
  synctex: boolean | null;
  /** The problem the writer meets first (an error before a warning), for the Build button's sequence. */
  issue: CompileDiagnostic | null;
  /** A quiet build's success (live-preview/quiet-builds.ts): the Build button shows it without its flourish. */
  quiet?: true;
};

/** The outcome a finished pass reports; null for one the writer stopped. */
export function buildOutcome(result: BuildResult, cancelled: boolean, quiet: boolean, wrotePdf: boolean): BuildOutcome | null {
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
    ? { status: "succeeded", seconds: result.durationMs / 1000, ...report, ...(quiet && { quiet: true as const }) }
    : cancelled ? null : { status: "failed", wrotePdf, ...report };
}

/** The outcome of a build the backend refused outright: no passes, no diagnostics. */
export function rejectedBuildOutcome(): BuildOutcome {
  return {
    status: "failed", wrotePdf: false, counts: { error: 0, warning: 0, info: 0 }, rootDocument: null, finishedAt: Date.now(),
    steps: [], pages: null, synctex: null, issue: null,
  };
}

/**
 * How long one pass may run before the pipeline stops it as stuck (a macro
 * that recurses forever, a figure that never finishes). Far past any real
 * document's build, so only a hang reaches it; before it, Stop was the only
 * way out of one.
 */
export const BUILD_TIMEOUT_MS = 10 * 60_000;

/**
 * A pass the timeout stopped comes back as a stopped build; say why, as a
 * failure the diagnostics panel opens on, rather than as one the writer asked for.
 */
export function timedOutBuild(result: BuildResult): BuildResult {
  const minutes = String(BUILD_TIMEOUT_MS / 60_000);
  return {
    ...result,
    diagnostics: result.diagnostics.map((item) => item.code === "build-cancelled" ? {
      ...item,
      code: "build-timed-out",
      params: { minutes },
      // The English source of truth, like the backend's own advice (compileDiagnosticText translates the display).
      // eslint-disable-next-line lingui/no-unlocalized-strings -- logs, copied reports and the agent read it as is
      message: `Build stopped after ${minutes} minutes without finishing. Something in the document may be looping; the log below is how far it got.`,
    } : item),
  };
}
