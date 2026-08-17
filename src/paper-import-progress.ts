import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "./i18n";

/** Tauri event carrying the literature pipeline's current stage id. */
export const PAPER_IMPORT_PROGRESS_EVENT = "paper-import-progress";

/**
 * Stage ids emitted by the Rust pipeline (see papers.rs
 * `import_reference_with_progress`). Unknown ids fall back to a generic
 * label instead of hiding the line: a renamed backend stage should degrade
 * to "Working…", not to a silent spinner.
 *
 * The table holds descriptors rather than finished strings because it is
 * module state: resolving at call time is what picks up the active catalog.
 */
const STAGE_LABELS: Record<string, MessageDescriptor> = {
  resolving: msg`Resolving citation metadata…`,
  fulltext: msg`Downloading full text and figures…`,
  overview: msg`Fetching the paper overview…`,
};

const FALLBACK_LABEL = msg`Working…`;

export function paperImportStageLabel(stage: string): string {
  return i18n._(STAGE_LABELS[stage] ?? FALLBACK_LABEL);
}
