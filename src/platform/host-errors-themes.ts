/**
 * Theme host errors (lattice-core's themes and registry modules) a writer
 * reads when a theme file cannot be installed or a theme cannot be removed in
 * Settings › Appearance, or the theme marketplace's list cannot be fetched or
 * a theme installed from it. See `host-error-text.ts` for how an entry is matched and pinned.
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
  ["registry/verify.rs", "The registry's {file} has no valid signature.", ([file]) => t`The registry's ${file} has no valid signature.`],
  ["registry/verify.rs", "The registry's {file} is signed for another file or serial.", ([file]) => t`The registry's ${file} is signed for another file or serial.`],
  ["registry.rs", "The registry's list is in a newer format. Update Lattice to use it.", () => t`The registry's list is in a newer format. Update Lattice to use it.`],
  ["registry.rs", "The registry is updating its list. Try again in a few minutes.", () => t`The registry is updating its list. Try again in a few minutes.`],
  ["registry.rs", "The registry sent an older list (serial {} after {}), so Lattice kept the one it has.", ([sent, kept]) => t`The registry sent an older list (serial ${sent} after ${kept}), so Lattice kept the one it has.`],
  ["registry.rs", "The registry could not be reached: {err}", ([error]) => t`The registry could not be reached: ${error}`],
  ["registry.rs", "The registry's {file} could not be read: {err}", ([file, error]) => t`The registry's ${file} could not be read: ${error}`],
  ["registry.rs", "Load the theme list before installing a theme from it.", () => t`Load the theme list before installing a theme from it.`],
  ["registry.rs", "\"{id}\" is not in the theme list.", ([id]) => t`"${id}" is not in the theme list.`],
  ["registry.rs", "{} {} is blocked: {}", ([name, version, reason]) => t`${name} ${version} is blocked: ${reason}`],
  ["registry.rs", "The theme download failed: {err}", ([error]) => t`The theme download failed: ${error}`],
  ["registry.rs", "The downloaded theme is not the size the theme list gives.", () => t`The downloaded theme is not the size the theme list gives.`],
  ["registry.rs", "The downloaded theme does not match the theme list's checksum.", () => t`The downloaded theme does not match the theme list's checksum.`],
  ["registry.rs", "The downloaded theme is not \"{id}\" {}.", ([id, version]) => t`The downloaded theme is not "${id}" ${version}.`],
  ["registry.rs", "{url} is not an https address.", ([url]) => t`${url} is not an https address.`],
  ["registry.rs", "{url} is larger than expected.", ([url]) => t`${url} is larger than expected.`],
  ["registry.rs", "Could not save the theme list: {err}", ([error]) => t`Could not save the theme list: ${error}`],
  ["ipc/themes.rs", "Could not show the themes folder in Finder: {error}", ([error]) => t`Could not show the themes folder in Finder: ${error}`],
  ["ipc/themes.rs", "Themes can only be installed from a Lattice window.", () => t`Themes can only be installed from a Lattice window.`],
];
