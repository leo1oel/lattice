/**
 * The command palette's Export figures for a journal. The export itself
 * (src/project/journal-export.ts) is loaded only when the command runs.
 */
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AppCommand } from "./use-app-commands";

const loadJournalExport = () => import("../project/journal-export");

export function journalExportCommand({ projectRoot, i18n, save }: {
  projectRoot: string | null;
  i18n: I18n;
  save: () => Promise<boolean>;
}): AppCommand {
  return {
    id: "export-journal", when: projectRoot !== null, label: i18n._(msg`Export figures for a journal…`), group: "project",
    keywords: i18n._(msg({ message: "Scheme TIFF submission ACS", comment: "Search words for the Export figures for a journal command, space-separated" })),
    run: () => {
      if (projectRoot !== null) void loadJournalExport().then(({ exportForJournal }) => exportForJournal(projectRoot, save));
    },
  };
}
