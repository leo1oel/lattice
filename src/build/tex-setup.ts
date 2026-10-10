import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

type DoctorCheckLike = { name: string; detail: string; ok: boolean };
export type DoctorReportLike = { ok: boolean; summary: string; checks: DoctorCheckLike[] };

/** Rough installed size after our one-click scripts finish. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a size with a unit, the same in every locale
export const TEX_INSTALL_SIZE_HINT = "1 GB";

export type TexInstallProgress = {
  stage: "downloading" | "authorizing" | "installing-base" | "installing-packages" | "installing-tools" | "verifying" | "complete";
  progress: number;
};

export type TexDependencyInstallProgress = {
  stage: "searching-packages" | "authorizing" | "installing-dependency" | "verifying-dependency" | "complete";
  progress: number;
};

const REQUIRED_ALWAYS = ["latexmk", "synctex", "bibtex"] as const;
const TEX_ENGINES = ["pdflatex", "xelatex", "lualatex"] as const;
/** The app-managed uv pair the paper tools (arXiv import, bibcite) run through. */
const PAPER_TOOLS = ["uv", "uvx"] as const;

function toolOk(report: DoctorReportLike, name: string): boolean {
  return report.checks.some((check) => check.name === name && check.ok);
}

/** Missing compile tools; any one engine will do. Ignores unrelated doctor checks (agent, git, …). */
export function missingTexToolNames(report: DoctorReportLike | null | undefined): string[] {
  if (!report) return [];
  const missing: string[] = REQUIRED_ALWAYS.filter((name) => !toolOk(report, name));
  if (!TEX_ENGINES.some((name) => toolOk(report, name))) missing.push("pdflatex");
  return missing;
}

export function isConferenceFontsMissing(report: DoctorReportLike | null | undefined): boolean {
  return !!report && report.checks.find((check) => check.name === "conference-fonts")?.ok !== true;
}

export function missingPaperToolNames(report: DoctorReportLike | null | undefined): string[] {
  return report ? PAPER_TOOLS.filter((name) => !toolOk(report, name)) : [];
}

/** What compiling needs: a TeX toolchain and the conference fonts. Setup blocks the app without it. */
export function isCompileSetupMissing(report: DoctorReportLike | null | undefined): boolean {
  return missingTexToolNames(report).length > 0 || isConferenceFontsMissing(report);
}

/**
 * Only the paper tools are missing: writing, compiling and reading all work,
 * so setup can wait until a paper feature asks for them.
 */
export function isOnlyPaperToolsMissing(report: DoctorReportLike | null | undefined): boolean {
  return missingPaperToolNames(report).length > 0 && !isCompileSetupMissing(report);
}

export function isRequiredSetupMissing(report: DoctorReportLike | null | undefined): boolean {
  return isCompileSetupMissing(report) || missingPaperToolNames(report).length > 0;
}

/** A paper feature failed because the managed uv/uvx are missing (`PAPER_TOOLS_MISSING` in src-tauri/src/commands/python_tools.rs). */
export function isMissingPaperToolsError(message: string): boolean {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- marker matched in backend error text
  return message.includes("Lattice's paper tools are not installed.");
}

export function isMissingTexBuildError(message: string): boolean {
  const lower = message.toLowerCase();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- markers matched in backend error text
  return ["could not start latexmk", "mactex or tex live", "the latex tool"].some((marker) => lower.includes(marker));
}

/*
 * The first lines `dependency_install_error` (src-tauri/src/tex_setup/installer.rs)
 * gives a failed package install, in the interface language. Keys are the
 * backend's exact English and must change with it.
 */
/* eslint-disable lingui/no-unlocalized-strings -- keys are backend error text */
const TEX_DEPENDENCY_FAILURES = new Map([
  ["Administrator approval was cancelled, so nothing was installed.",
    msg`Administrator approval was cancelled, so nothing was installed.`],
  ["There is not enough disk space to install the package. Free up some space, then try again.",
    msg`There is not enough disk space to install the package. Free up some space, then try again.`],
  ["Lattice could not write to the TeX installation folder.",
    msg`Lattice could not write to the TeX installation folder.`],
  ["This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.",
    msg`This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.`],
  ["The package repository does not have this package.",
    msg`The package repository does not have this package.`],
  ["Could not reach the TeX Live package repository. Check the network connection, then try again.",
    msg`Could not reach the TeX Live package repository. Check the network connection, then try again.`],
  ["TeX Live's package manager needs an update, and the update did not finish.",
    msg`TeX Live’s package manager needs an update, and the update did not finish.`],
  ["TeX Live's package manager could not install the package.",
    msg`TeX Live’s package manager could not install the package.`],
]);
/* eslint-enable lingui/no-unlocalized-strings */

/** A failed package install's message as a translated summary and tlmgr's own words. */
export function texDependencyInstallFailure(message: string): { summary: string; detail: string } {
  const [first = "", ...rest] = message.split("\n");
  const known = TEX_DEPENDENCY_FAILURES.get(first);
  return { summary: known ? i18n._(known) : first, detail: rest.join("\n").trim() };
}
