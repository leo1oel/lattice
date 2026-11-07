/* eslint-disable lingui/no-unlocalized-strings -- The answer's note is read by the model, never rendered by Lattice UI. */

import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { confirmAction, toMessage } from "../app-utils";
import { showError } from "../app/notify";
import { i18n } from "../i18n";
import { announceBibliographyWrite } from "../project/project-files-changed";

type RemovalPreview = { key: string; removed: boolean; blockers: { path: string; line: number }[] };

/** Removals waiting on the writer, by project root and key, so a retried request asks once. */
const pending = new Set<string>();

/**
 * The agent's `remove_reference`. Deleting a bibliography entry is the
 * writer's call, not the agent's: a citation check that took a citation out
 * of a sentence went on to delete the entry it had pointed to, although an
 * entry nobody cites is harmless (BibTeX lists only cited entries) and a
 * shared or curated .bib loses data. The native broker cannot delete at all
 * (`AgentBibliographyMutation`); this answers the agent at once and puts the
 * question to the writer in Lattice's own confirmation dialog, because the
 * agent stops waiting for a tool after 30 seconds and the writer may be
 * reading. Only their Remove entry runs the interface's removal, recorded in
 * History like one from the paper library.
 */
export async function requestAgentReferenceRemoval(
  key: string,
  projectRoot: string,
  isCurrent: () => boolean,
): Promise<Record<string, unknown>> {
  // Errors for a key the primary bibliography does not hold.
  const preview = await invoke<RemovalPreview>("remove_reference", { key, citationMode: "preview", projectRoot });
  if (preview.blockers.length) {
    return { key: preview.key, removed: false, blockers: preview.blockers, note: "The manuscript still cites this key, so the entry was kept." };
  }
  const id = `${projectRoot}\0${preview.key}`;
  if (!pending.has(id)) {
    pending.add(id);
    void confirmRemoval(preview.key, projectRoot, isCurrent).finally(() => pending.delete(id));
  }
  return {
    key: preview.key,
    removed: false,
    awaitingUserConfirmation: true,
    note: "Lattice asked the user whether to delete this entry; it stays in the bibliography unless they confirm. "
      + "An entry nobody cites is harmless: BibTeX lists only cited entries. "
      + "Do not report the entry as removed, and do not delete bibliography entries the user did not ask you to delete.",
  };
}

async function confirmRemoval(key: string, projectRoot: string, isCurrent: () => boolean) {
  const confirmed = await confirmAction({
    title: i18n._(msg`Remove ${key} from the bibliography?`),
    message: [
      i18n._(msg`The agent asked to delete this entry. Nothing in the paper cites it now, and an entry nobody cites is harmless: BibTeX lists only cited entries.`),
      i18n._(msg`Downloaded paper files will be kept.`),
    ].join(" "),
    confirmLabel: i18n._(msg`Remove entry`),
    cancelLabel: i18n._(msg`Keep entry`),
    destructive: true,
  }).catch(() => false);
  if (!confirmed || !isCurrent()) return;
  try {
    // Block mode scans the files again: a citation written while the
    // dialog was up keeps the entry.
    const result = await invoke<RemovalPreview>("remove_reference", { key, projectRoot });
    if (!isCurrent()) return;
    if (!result.removed) {
      showError(i18n._(msg`The paper cites ${key} again, so its entry was kept.`));
      return;
    }
    announceBibliographyWrite(projectRoot);
  } catch (reason) {
    if (isCurrent()) showError(toMessage(reason));
  }
}
