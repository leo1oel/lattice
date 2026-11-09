import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

// Only the Settings TeX doctor reads a check's error, so this stays out of
// src/build/tex-package-updates.ts, which the eagerly loaded setup wizard
// imports (docs/architecture.md §4.1).

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
