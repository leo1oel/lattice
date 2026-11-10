// Help ▸ Report a Problem… (and the palette's "Report a problem"): save the
// log export Settings › Logs › Export makes by default — redacted, operation
// metadata and counts only — show it in Finder, and open a new bug report
// with the Lattice and macOS versions filled in.
//
// The issue page is public and its address travels through the browser's
// history, so the address carries the versions and the architecture and
// nothing from the log; the reporter attaches the saved file themselves,
// after reading it if they like.
//
// On a release older than one the updater found, it says so first and offers
// the update: people otherwise report problems that release already fixed.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { msg } from "@lingui/core/macro";
import { version } from "../../package.json";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { addAppLog, getAppLogEntries } from "../telemetry/app-log-store";
import { createAppLogExport } from "../telemetry/app-log-export";
import { getKnownUpdate } from "../telemetry/outdated-version";

/** What `save_problem_report` (diagnostic_logs.rs) answers. */
type ProblemReport = { osVersion: string | null; arch: string };

/** The bug report form, with its version fields (`.github/ISSUE_TEMPLATE/bug_report.yml`) filled in. */
export function newIssueUrl(report: ProblemReport, latticeVersion = version): string {
  const url = new URL("https://github.com/leo1oel/lattice/issues/new");
  url.searchParams.set("template", "bug_report.yml");
  url.searchParams.set("lattice-version", latticeVersion);
  url.searchParams.set("macos-version", `macOS ${report.osVersion ?? "unknown"} (${report.arch})`);
  return url.toString();
}

export async function reportProblem(): Promise<void> {
  const update = getKnownUpdate();
  if (!update) return fileReport();
  const { running, latest } = update;
  addAppLog({
    level: "warning",
    source: i18n._(msg`Report a problem`),
    title: i18n._(msg`You’re on v${running}; v${latest} is available`),
    detail: i18n._(msg`It may already fix this. Update first, or report the problem anyway.`),
    dedupeKey: "report-problem-outdated",
    toastOptions: {
      timeoutMs: 0,
      primaryAction: { label: i18n._(msg`Update now`), onClick: update.updateNow },
      secondaryAction: { label: i18n._(msg`Report anyway`), onClick: fileReport },
    },
  });
}

async function fileReport(): Promise<void> {
  const contents = JSON.stringify(createAppLogExport(getAppLogEntries()), null, 2);
  let report: ProblemReport;
  try {
    report = await invoke<ProblemReport>("save_problem_report", { contents });
  } catch (reason) {
    addAppLog({
      level: "error", source: i18n._(msg`Report a problem`), title: i18n._(msg`Couldn’t save the diagnostic log`), detail: toMessage(reason),
    });
    return;
  }
  addAppLog({
    level: "info",
    source: i18n._(msg`Report a problem`),
    title: i18n._(msg`Diagnostic log saved`),
    detail: i18n._(msg`Attach the file shown in Finder to the bug report.`),
  });
  await openUrl(newIssueUrl(report));
}
