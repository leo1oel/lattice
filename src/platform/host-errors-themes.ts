/**
 * Theme host errors (lattice-core's themes module) a writer reads when a theme
 * file cannot be installed or a theme cannot be removed in Settings ›
 * Appearance. See `host-error-text.ts` for how an entry is matched and pinned.
 */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";

/* eslint-disable lingui/no-unlocalized-strings -- the host's English is matched as data; each translation is the t`` beside it */

export const THEMES_HOST_ERRORS: readonly HostErrorEntry[] = [
  ["themes.rs", "\"{}\" is the id of a theme that comes with Lattice. Give your theme its own id.", ([id]) => t`"${id}" is the id of a theme that comes with Lattice. Give your theme its own id.`],
  ["themes.rs", "Could not create the themes folder: {err}", ([error]) => t`Could not create the themes folder: ${error}`],
  ["themes.rs", "Could not save the theme: {err}", ([error]) => t`Could not save the theme: ${error}`],
  ["themes.rs", "Could not read {}: {err}", ([path, error]) => t`Could not read ${path}: ${error}`],
  ["themes.rs", "The theme file is larger than 256 KiB.", () => t`The theme file is larger than 256 KiB.`],
  ["themes.rs", "This theme comes with Lattice and cannot be removed.", () => t`This theme comes with Lattice and cannot be removed.`],
  ["themes.rs", "Could not remove the theme: {err}", ([error]) => t`Could not remove the theme: ${error}`],
];
