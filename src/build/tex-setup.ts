type DoctorCheckLike = { name: string; detail: string; ok: boolean };
export type DoctorReportLike = { ok: boolean; summary: string; checks: DoctorCheckLike[] };

/** Rough installed size after our one-click scripts finish. */
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
const REQUIRED_APP_TOOLS = ["uv", "uvx"] as const;

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

export function missingRequiredToolNames(report: DoctorReportLike | null | undefined): string[] {
  return report ? REQUIRED_APP_TOOLS.filter((name) => !toolOk(report, name)) : [];
}

export function isRequiredSetupMissing(report: DoctorReportLike | null | undefined): boolean {
  return missingTexToolNames(report).length > 0
    || isConferenceFontsMissing(report)
    || missingRequiredToolNames(report).length > 0;
}

export function isMissingTexBuildError(message: string): boolean {
  const lower = message.toLowerCase();
  return ["could not start latexmk", "mactex or tex live", "the latex tool"].some((marker) => lower.includes(marker));
}
