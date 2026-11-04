/** Desktop companion package and window errors, kept with the lazy host catalog. */
import { t } from "@lingui/core/macro";
import type { HostErrorEntry } from "./host-error-text";
/* eslint-disable lingui/no-unlocalized-strings -- the host English is matched as data; translations are the t expressions */
export const DESKTOP_PET_HOST_ERRORS: readonly HostErrorEntry[] = [
  ["desktop_pet/launch.rs", "The desktop companion request was cancelled.", () => t`The desktop companion request was cancelled.`],
  ["desktop_pet/launch.rs", "The desktop companion did not finish loading. Try enabling it again.", () => t`The desktop companion did not finish loading. Try enabling it again.`],
  ["desktop_pet/launch.rs", "The desktop companion could not load its artwork. Import its package again.", () => t`The desktop companion could not load its artwork. Import its package again.`],
  ["desktop_pet.rs", "Pet artwork is available only to its companion window", () => t`Pet artwork is available only to its companion window`],
  ["desktop_pet.rs", "The saved pet artwork is invalid; import its package again", () => t`The saved pet artwork is invalid; import its package again`],
  ["desktop_pet.rs", "Open a desktop workspace to import a pet", () => t`Open a desktop workspace to import a pet`],
  ["desktop_pet.rs", "Import a pet package first", () => t`Import a pet package first`],
  ["desktop_pet.rs", "Pet settings have no folder", () => t`Pet settings have no folder`],
  ["desktop_pet/package.rs", "Pet file could not be opened", () => t`Pet file could not be opened`],
  ["desktop_pet/package.rs", "Pet file could not be read", () => t`Pet file could not be read`],
  ["desktop_pet/package.rs", "Pet file is too large", () => t`Pet file is too large`],
  ["desktop_pet/package.rs", "Choose a pet.json file", () => t`Choose a pet.json file`],
  ["desktop_pet/package.rs", "The pet manifest is invalid", () => t`The pet manifest is invalid`],
  ["desktop_pet/package.rs", "The pet needs a name of at most 80 characters", () => t`The pet needs a name of at most 80 characters`],
  ["desktop_pet/package.rs", "Supported pet sprite versions are 1 and 2", () => t`Supported pet sprite versions are 1 and 2`],
  ["desktop_pet/package.rs", "The pet package has no folder", () => t`The pet package has no folder`],
  ["desktop_pet/package.rs", "The pet spritesheet could not be found", () => t`The pet spritesheet could not be found`],
  ["desktop_pet/package.rs", "The spritesheet must stay inside the pet package folder", () => t`The spritesheet must stay inside the pet package folder`],
  ["desktop_pet/package.rs", "Use a PNG or WebP spritesheet", () => t`Use a PNG or WebP spritesheet`],
  ["desktop_pet/package.rs", "The spritesheet must be 1536 × {expected_height} pixels", ([height]) => t`The spritesheet must be 1536 × ${height} pixels`],
];
