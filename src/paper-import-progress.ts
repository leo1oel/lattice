/** Tauri event carrying the literature pipeline's current stage id. */
export const PAPER_IMPORT_PROGRESS_EVENT = "paper-import-progress";

/**
 * Stage ids emitted by the Rust pipeline (see papers.rs
 * `import_reference_with_progress`). Unknown ids fall back to a generic
 * label instead of hiding the line: a renamed backend stage should degrade
 * to "Working…", not to a silent spinner.
 */
const STAGE_LABELS: Record<string, string> = {
  resolving: "Resolving citation metadata…",
  fulltext: "Downloading full text and figures…",
  overview: "Fetching the paper overview…",
};

export function paperImportStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? "Working…";
}
