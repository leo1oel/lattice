import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import { chooseAction, confirmAction, paperKey, toMessage } from "../app-utils";
import { i18n } from "../i18n";
import type { SymbolOccurrence } from "../project/references-panel";
import { showError } from "./notify";

type RemoveReferenceResult = {
  key: string;
  removed: boolean;
  blockers: SymbolOccurrence[];
  changedFiles: string[];
  removedCitations: number;
  transactionId?: string | null;
  changes?: Array<{
    path: string;
    before: string;
    after: string;
  }>;
};

/**
 * Remove `paper`'s entry from the primary bibliography, after the writer
 * confirms (and chooses what happens to its citations, when it is cited).
 * Every await is followed by a check that the same project is still open: a
 * switch while the confirmation is up abandons the removal. Outside
 * usePaperActions because its try/catch makes the React Compiler skip the
 * hook that holds it.
 */
export async function removeReference(paper: PaperSummary, {
  project, captureProjectScope, flush, save, activeFile, activeFileRef, sourceRef, accept, markDiskVersion,
  activePaper, leavePaper, refreshProject, refreshHistory,
}: {
  project: { root: string; manifest: { primaryBibliography: string } } | null;
  captureProjectScope: () => () => boolean;
  flush: () => boolean;
  save: () => Promise<boolean>;
  activeFile: string;
  activeFileRef: { readonly current: string };
  sourceRef: { readonly current: string };
  accept: (path: string, content: string) => boolean;
  markDiskVersion: () => Promise<unknown>;
  activePaper: PaperSummary | null;
  leavePaper: () => void;
  refreshProject: () => Promise<unknown>;
  refreshHistory: () => Promise<unknown>;
}): Promise<void> {
  if (!paper.citationKey) {
    showError(i18n._(msg`This bibliography entry has no citation key to remove.`));
    return;
  }
  const projectRoot = project?.root;
  if (!projectRoot) return;
  const operationIsCurrent = captureProjectScope();
  try {
    // The blocker scan runs in Rust against durable project files. Flush the
    // editor first so a citation removed moments ago does not survive only
    // on disk and produce a blocker the visible document cannot find.
    if (!flush()) return;
    if (!await save()) return;
    const bibliographyPath = project?.manifest.primaryBibliography;
    const preview = await invoke<RemoveReferenceResult>("remove_reference", {
      key: paper.citationKey,
      citationMode: "preview",
      projectRoot,
    });
    if (!operationIsCurrent()) return;
    let citationMode: "keep" | "remove" | undefined;
    const title = paper.title;
    const confirmationTitle = i18n._(msg`Remove “${title}” from the bibliography?`);
    if (preview.blockers.length) {
      const count = preview.blockers.length;
      const first = preview.blockers[0];
      const citationCount = count === 1
        ? i18n._(msg`This entry is cited in 1 place.`)
        : i18n._(msg`This entry is cited in ${count} places.`);
      let location = "";
      if (first) {
        const { path, line } = first;
        location = i18n._(msg`The first is at ${path}:${line}.`);
      }
      const choice = await chooseAction({
        title: confirmationTitle,
        message: [
          citationCount,
          location,
          i18n._(msg`Keeping the citation commands will leave them unresolved.`),
          i18n._(msg`Downloaded paper files will be kept.`),
        ].filter(Boolean).join(" "),
        confirmLabel: i18n._(msg`Remove citations too`),
        alternativeLabel: i18n._(msg`Keep citations`),
        alternativeDestructive: true,
        destructive: true,
      });
      if (choice === "cancel") return;
      citationMode = choice === "confirm" ? "remove" : "keep";
    } else {
      const confirmed = await confirmAction({
        title: confirmationTitle,
        message: i18n._(msg`Downloaded paper files will be kept.`),
        confirmLabel: i18n._(msg`Remove entry`),
        destructive: true,
      });
      if (!confirmed) return;
    }
    if (!operationIsCurrent()) return;
    const result = await invoke<RemoveReferenceResult>("remove_reference", {
      key: paper.citationKey,
      ...(citationMode ? { citationMode } : {}),
      projectRoot,
    });
    if (!operationIsCurrent()) return;
    if (!result.removed) {
      const first = result.blockers[0];
      const citationCommand = `\\cite{${paper.citationKey}}`;
      const blocker = first ? `${first.path}:${first.line}` : "";
      showError(first
        ? i18n._(msg`The bibliography changed while removing ${citationCommand} (${blocker}). Try again.`)
        : i18n._(msg`Could not remove ${citationCommand}.`));
      return;
    }

    // The user can keep editing while the confirmation is
    // open. Rust returns the exact input/output pair for every file so the UI
    // can refuse to merge a stale whole-file result into a newer buffer.
    let conflictPath: string | null = null;
    for (const change of result.changes ?? []) {
      const diverged = (text: string) => text !== change.before && text !== change.after;
      if (activeFileRef.current === change.path && diverged(sourceRef.current)) {
        conflictPath = change.path;
        break;
      }
    }
    if (conflictPath) {
      // Revert itself is compare-and-swap guarded. If disk also changed,
      // leave both versions intact and direct the user to History.
      const reverted = Boolean(result.transactionId) && await invoke("revert_transaction", {
        transactionId: result.transactionId, projectRoot,
      }).then(() => true, () => false);
      if (operationIsCurrent()) {
        showError(reverted
          ? i18n._(msg`${conflictPath} changed while the reference was being removed. Nothing was removed; try again.`)
          : i18n._(msg`${conflictPath} changed while the reference was being removed. The newer text was preserved; review the removal in History.`));
        await refreshProject();
        await refreshHistory();
      }
      return;
    }

    const changedFiles = result.changedFiles?.length ? result.changedFiles : bibliographyPath ? [bibliographyPath] : [];
    const returnedChanges = new Map((result.changes ?? []).map((change) => [change.path, change.after]));
    for (const path of changedFiles) {
      const content = returnedChanges.get(path) ?? await invoke<string>("read_project_file", { path, projectRoot });
      if (path === activeFile && accept(path, content)) await markDiskVersion();
    }
    if (activePaper && paperKey(activePaper) === paperKey(paper)) leavePaper();
    await refreshProject();
    await refreshHistory();
  } catch (reason) {
    showError(toMessage(reason));
  }
}
