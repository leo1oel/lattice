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

/*
 * What tlmgr (or the backend's timeout) says, lowercased, when the
 * repository could not be reached. The first `DEPENDENCY_INSTALL_FAILURES`
 * network signs in installer.rs, plus the doctor's own timeout.
 */
/* eslint-disable lingui/no-unlocalized-strings -- backend and tlmgr text */
const UNREACHABLE_REPOSITORY_SIGNS = [
  "did not answer within",
  "could not get texlive.tlpdb",
  "cannot contact",
  "could not resolve host",
  "connection",
  "timed out",
  "unable to download",
];
const OLDER_THAN_REPOSITORY_SIGN = "older than remote repository";
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * Why the doctor could not check for package updates, from the check's
 * `error`: a translated summary and, unless the network is to blame,
 * tlmgr's own words. A release older than the repository is checked first:
 * every repository tried says so, and a later one may also time out.
 */
export function texPackageCheckProblem(error: string): { summary: string; detail: string } {
  const lowercase = error.toLowerCase();
  if (lowercase.includes(OLDER_THAN_REPOSITORY_SIGN)) {
    return {
      summary: i18n._(msg`This TeX Live release is older than the package repository. Install the current TeX Live release, then try again.`),
      detail: error.trim(),
    };
  }
  if (UNREACHABLE_REPOSITORY_SIGNS.some((sign) => lowercase.includes(sign))) {
    return {
      summary: i18n._(msg`Couldn’t check for updates. Check the network connection, then run the TeX doctor again.`),
      detail: "",
    };
  }
  return { summary: i18n._(msg`Couldn’t check for updates`), detail: error.trim() };
}
