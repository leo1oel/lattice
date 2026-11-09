import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { hostErrorText } from "../platform/host-error-text";

/** `TexPackageUpdates` in src-tauri/src/tex_setup/package_updates.rs. */
export type TexPackageUpdatesReport = {
  /** The TeX is a BasicTeX, which Lattice installed and may update itself. */
  managed: boolean;
  packages: { name: string; installed: string; available: string }[];
  /** Why the repository could not be asked; then `packages` says nothing. */
  error?: string;
};

export type TexPackageUpdateProgress = {
  stage: "authorizing" | "updating-packages" | "complete";
  progress: number;
};

/** `UPDATE_COMMAND` in package_updates.rs: what to run for a TeX Lattice does not manage. */
// eslint-disable-next-line lingui/no-unlocalized-strings -- a shell command, the same in every locale
export const TEX_PACKAGE_UPDATE_COMMAND = "sudo tlmgr update --self --all";

/*
 * First lines the backend gives a package update problem (installer.rs), in
 * the interface language. Keys are the backend's exact English and must
 * change with it.
 */
/* eslint-disable lingui/no-unlocalized-strings -- keys are backend text */
const PACKAGE_UPDATE_MESSAGES = new Map([
  ["Administrator approval was cancelled, so nothing was updated.",
    msg`Administrator approval was cancelled, so nothing was updated.`],
  ["TeX Live's package manager could not update the packages.",
    msg`TeX Live’s package manager could not update the packages.`],
  ["BasicTeX is installed, but its LaTeX packages could not be updated. Update them later from Settings → TeX doctor.",
    msg`BasicTeX is installed, but its LaTeX packages could not be updated. Update them later from Settings → TeX doctor.`],
]);
/* eslint-enable lingui/no-unlocalized-strings */

/** A package update failure or install warning as a translated summary and tlmgr's own words. */
export function texPackageUpdateMessage(message: string): { summary: string; detail: string } {
  const [first = "", ...rest] = message.split("\n");
  const known = PACKAGE_UPDATE_MESSAGES.get(first);
  if (known) return { summary: i18n._(known), detail: rest.join("\n").trim() };
  const [summary = "", ...detail] = hostErrorText(message).split("\n");
  return { summary, detail: detail.join("\n").trim() };
}
