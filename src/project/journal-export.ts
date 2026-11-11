/**
 * Export figures for a journal: each figure made from a drawing as the files
 * a journal asks for (`Scheme1.pdf`, `Scheme1.tiff`), with the compound numbers
 * the document sets over it, and the paper as a source pack that includes
 * those files (`src-tauri/src/latex/arxiv/journal.rs`). Loaded only when the
 * command runs.
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { hostErrorMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError, notifyInfo, notifySuccess } from "../telemetry/app-notify";

type JournalExport = {
  folder: string;
  figures: string[];
  problems: string[];
  article?: { outcome: "ok" | "failed" | "timedOut" | "cancelled" };
};

/**
 * Journals ask for 300 dpi in colour and up to 1200 for line art; 600 keeps a
 * scheme's thin bonds and small numbers sharp at a size they all accept.
 */
const TIFF_DPI = 600;

/** Asks where to put the export, saves the open file, and writes it there in a folder of its own. */
export async function exportForJournal(projectRoot: string, save: () => Promise<boolean>): Promise<void> {
  const title = i18n._(msg`Export figures for a journal`);
  const parent = await open({ directory: true, multiple: false, title: i18n._(msg`Choose where to put the figures for the journal`) });
  if (typeof parent !== "string") return;
  if (!(await save())) return;
  notifyInfo(title, i18n._(msg`Typesetting the paper to cut out its figures…`), { dedupeKey: "journal-export" });
  try {
    const result = await invoke<JournalExport>("export_journal_figures", {
      projectRoot,
      options: { tiff: true, dpi: TIFF_DPI, article: true },
      parentFolder: parent,
    });
    const figures = result.figures.join(", ");
    const notify = result.problems.length ? notifyInfo : notifySuccess;
    notify(title, i18n._(msg`Exported ${figures} and the paper that includes them`), {
      dedupeKey: "journal-export",
      detail: result.problems.join("\n"),
      timeoutMs: result.problems.length ? 0 : undefined,
      primaryAction: {
        label: i18n._(msg`Show in Finder`),
        onClick: () => { void revealItemInDir(result.folder).catch(() => undefined); },
      },
    });
  } catch (reason) {
    notifyError(title, hostErrorMessage(reason), { dedupeKey: "journal-export" });
  }
}
