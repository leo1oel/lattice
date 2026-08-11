export type DoctorCheckLike = { name: string; detail: string; ok: boolean };
export type DoctorReportLike = { ok: boolean; summary: string; checks: DoctorCheckLike[] };

/** Rough installed size after our one-click scripts finish. */
export const TEX_INSTALL_SIZE_HINT = "1.2 GB";

export type TexInstallProgress = {
  stage: "downloading" | "authorizing" | "installing-base" | "installing-packages" | "verifying" | "complete";
  progress: number;
};

const REQUIRED_ALWAYS = ["latexmk", "synctex", "bibtex"] as const;

function toolOk(report: DoctorReportLike, name: string): boolean {
  return report.checks.some((check) => check.name === name && check.ok);
}

export function missingTexToolNames(report: DoctorReportLike | null | undefined): string[] {
  if (!report) return [];
  const missing: string[] = [];
  for (const name of REQUIRED_ALWAYS) {
    if (!toolOk(report, name)) missing.push(name);
  }
  const hasEngine =
    toolOk(report, "pdflatex") || toolOk(report, "xelatex") || toolOk(report, "lualatex");
  if (!hasEngine) missing.push("pdflatex");
  return missing;
}

/** True when compile tools are missing. Ignores unrelated doctor checks (agent, git, …). */
export function isTexToolchainMissing(report: DoctorReportLike | null | undefined): boolean {
  if (!report) return false;
  return missingTexToolNames(report).length > 0;
}

export function isConferenceFontsMissing(report: DoctorReportLike | null | undefined): boolean {
  if (!report) return false;
  const fonts = report.checks.find((check) => check.name === "conference-fonts");
  // Older builds had no font check — don't claim missing.
  if (!fonts) return false;
  return !fonts.ok;
}

export function isMissingTexBuildError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("could not start latexmk")
    || lower.includes("mactex or tex live")
    || (lower.includes("latexmk") && lower.includes("not found"))
    || (lower.includes("pdflatex") && lower.includes("not found"))
    || lower.includes("the latex tool")
  );
}
