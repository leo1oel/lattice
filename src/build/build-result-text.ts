import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import type { DiagnosticCounts } from "./compile-diagnostics";

/** "1 error · 2 warnings · 1 note", leaving out what the build did not report. */
export function diagnosticCountsText(counts: DiagnosticCounts): string {
  const { error: errors, warning: warnings, info: notes } = counts;
  return [
    errors ? errors === 1 ? i18n._(msg`${errors} error`) : i18n._(msg`${errors} errors`) : "",
    warnings ? warnings === 1 ? i18n._(msg`${warnings} warning`) : i18n._(msg`${warnings} warnings`) : "",
    notes ? notes === 1 ? i18n._(msg`${notes} note`) : i18n._(msg`${notes} notes`) : "",
  ].filter(Boolean).join(" · ");
}

/**
 * How a build ended, in the one sentence the Build button and the diagnostics
 * bar above the PDF both use: "Built", "Built with 2 warnings", "Build failed ·
 * 1 error". A build with warnings still built, and says so first. So does a
 * failed one whose PDF is on screen (TeX carries on past errors unless the
 * project stops on the first): "Built with 2 errors" is what that PDF is.
 */
export function buildHeadline(succeeded: boolean, counts: DiagnosticCounts, wrotePdf = false): string {
  const issues = diagnosticCountsText(counts);
  if (succeeded) return issues ? i18n._(msg`Built with ${issues}`) : i18n._(msg`Built`);
  // Its own message: zh-CN's success sentence says the build succeeded.
  if (wrotePdf && counts.error > 0) return i18n._(msg({ message: `Built with ${issues}`, context: "a failed build whose PDF was still written" }));
  return issues ? i18n._(msg`Build failed · ${issues}`) : i18n._(msg`Build failed`);
}
