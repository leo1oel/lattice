/**
 * Every host message the interface translates, loaded beside a non-English
 * catalog by `activateAppLocale` (see `host-error-text.ts`).
 */
import type { HostErrorEntry } from "./host-error-text";
import { OVERLEAF_HOST_ERRORS } from "./host-errors-overleaf";
import { PAPERS_HOST_ERRORS } from "./host-errors-papers";
import { PROJECT_HOST_ERRORS } from "./host-errors-project";
import { WORKSPACE_HOST_ERRORS } from "./host-errors-workspace";

export const HOST_ERRORS: readonly HostErrorEntry[] = [
  ...PROJECT_HOST_ERRORS,
  ...WORKSPACE_HOST_ERRORS,
  ...OVERLEAF_HOST_ERRORS,
  ...PAPERS_HOST_ERRORS,
];
