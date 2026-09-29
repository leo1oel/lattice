import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

/**
 * Commit messages Lattice writes into the project's git history. That history
 * is shared with collaborators and remotes, so it stays English whatever the
 * interface language; only the versions list shows these translated.
 */
export const AUTO_COMMIT_MESSAGES = {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- persisted git history, translated by versionMessageLabel
  overleafSync: "Overleaf sync",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- persisted git history, translated by versionMessageLabel
  autoSaved: "Auto-saved version",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- persisted git history, translated by versionMessageLabel
  saved: "Saved version",
  // Written by the host (git.rs) when version tracking starts.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- persisted git history, translated by versionMessageLabel
  initialized: "Initialize version tracking",
} as const;

const LABELS: Record<string, MessageDescriptor> = {
  [AUTO_COMMIT_MESSAGES.overleafSync]: msg`Overleaf sync`,
  [AUTO_COMMIT_MESSAGES.autoSaved]: msg`Auto-saved version`,
  [AUTO_COMMIT_MESSAGES.saved]: msg`Saved version`,
  [AUTO_COMMIT_MESSAGES.initialized]: msg`Initialize version tracking`,
};

/** Written by the host (git.rs) when the whole project is restored. */
const RESTORE_MESSAGE = /^Restore project to (\S+)$/;

/** A commit message as the versions list shows it: Lattice's own in the interface language, the rest as written. */
export function versionMessageLabel(message: string): string {
  const known = Object.hasOwn(LABELS, message) ? LABELS[message] : undefined;
  if (known) return i18n._(known);
  const restored = RESTORE_MESSAGE.exec(message)?.[1];
  if (restored) return i18n._(msg`Restore project to ${restored}`);
  return message;
}
