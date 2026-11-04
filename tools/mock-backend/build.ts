/**
 * Builds as the backend reports them, without TeX: the passes latexmk
 * announces, the build that fails on a mistyped command until it is fixed,
 * and a build still under way. A page puts them together into its
 * `build_project` answer with its own log and PDF.
 */
import type { MockTauri } from "./tauri-internals";
import type { ProjectFiles } from "./project";

/** The passes a build runs, as latexmk announces them: pdflatex, bibtex, pdflatex again. */
export const BUILD_STEPS = [
  { tool: "pdflatex", run: 1, draft: false, startedMs: 0, durationMs: 612 },
  { tool: "bibtex", run: 1, draft: false, startedMs: 612, durationMs: 96 },
  { tool: "pdflatex", run: 2, draft: false, startedMs: 708, durationMs: 431 },
];
/** The same after a preamble edit: the preamble format is made first (src-tauri/src/latex/preamble_format.rs). */
export const PREAMBLE_BUILD_STEPS = [
  { tool: "pdflatex -ini", run: 1, draft: false, startedMs: 0, durationMs: 251 },
  { tool: "pdflatex", run: 1, draft: false, startedMs: 251, durationMs: 402 },
  { tool: "bibtex", run: 1, draft: false, startedMs: 653, durationMs: 96 },
  { tool: "pdflatex", run: 2, draft: false, startedMs: 749, durationMs: 288 },
];

/**
 * main.tex mistypes \citep as \cietp, so the build fails on it and the
 * explained build error can be tried. The first \citep is the one mistyped;
 * a main.tex that cites nothing gets a paragraph that does.
 */
export function stageTypo(files: ProjectFiles) {
  const main = files.get("main.tex");
  if (typeof main !== "string" || main.includes("\\cietp")) return;
  files.set("main.tex", main.includes("\\citep{")
    ? main.replace("\\citep{", "\\cietp{")
    : main.replace("\\end{document}", "Attention follows \\citep{bahdanau2015} and \\citep{vaswani2017}; see \\cietp{luong2015effective}.\n\\end{document}"));
}

/** What TeX reports for stageTypo's \\cietp, at the line it is on now; null once it is fixed. */
export function typoFailure(main: string) {
  const lines = main.split("\n");
  const index = lines.findIndex((text) => text.includes("\\cietp"));
  if (index < 0) return null;
  const line = index + 1;
  const text = lines[index]!;
  const end = text.indexOf("\\cietp") + "\\cietp".length;
  // The mistyped command cites nothing, so its key is reported undefined too.
  const key = /\\cietp\{([^,}]+)/.exec(text)?.[1] ?? "luong2015effective";
  return {
    log: [`./main.tex:${line}: Undefined control sequence.`, `l.${line} ${text.slice(0, end)}`, `${" ".repeat(end + 4)}${text.slice(end)}`],
    diagnostics: [
      { level: "error", message: "Undefined control sequence.", file: "main.tex", line },
      { level: "warning", message: `Citation \`${key}' on page 1 undefined on input line ${line}.` },
      { level: "warning", message: "Overfull \\hbox (6.1pt too wide) in paragraph at lines 38--41", file: "main.tex", line: 38 },
    ],
  };
}

/** A build log with TeX's error two thirds of the way down, where a real one stops the run. */
export function withError(log: string, error: string[]) {
  const lines = log.split("\n");
  const at = Math.floor(lines.length * 2 / 3);
  lines.splice(at, 0, ...error);
  return lines.join("\n");
}

/**
 * A build that never finishes, reporting its passes as latexmk would (the
 * backend's `build-progress`), so the Build button's live sequence can be
 * looked at. It stays in its second pdflatex pass.
 */
export function runningBuild(tauri: MockTauri, projectRoot: string, progressId: unknown): Promise<never> {
  const report = (elapsedMs: number, count: number) => window.setTimeout(() => tauri.emit("build-progress", {
    projectRoot,
    progressId: progressId ?? null,
    elapsedMs,
    steps: BUILD_STEPS.slice(0, count).map((step, index) => index === count - 1 ? { ...step, durationMs: null } : step),
  }), elapsedMs);
  BUILD_STEPS.forEach((step, index) => report(step.startedMs, index + 1));
  return new Promise<never>(() => {});
}
