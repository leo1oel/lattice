import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { i18n } from "../i18n";
import { useEffect, useRef } from "react";

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

const STAGE_ESTIMATES = {
  resolving: { ceiling: 33, milliseconds: 4000 },
  fulltext: { ceiling: 66, milliseconds: 12000 },
  overview: { ceiling: 95, milliseconds: 4000 },
};
type ImportStage = keyof typeof STAGE_ESTIMATES;

/** Estimated motion, not measured download percentages. Never reaches 100%. */
export function paperImportProgressAt(start: number, stage: ImportStage, elapsed: number): number {
  const { ceiling, milliseconds } = STAGE_ESTIMATES[stage];
  const time = Math.max(0, elapsed) / milliseconds;
  // Move uniformly through most of each stage, then creep toward its ceiling
  // if the request runs long. A new stage continues from the current width.
  const fraction = time <= 1 ? 0.9 * time : 1 - 0.1 * Math.exp(1 - time);
  return Math.max(start, start + (ceiling - start) * fraction);
}

export function usePaperImportProgressFill(active: boolean, stage?: string | null) {
  const fill = useRef<HTMLSpanElement>(null);
  const progress = useRef(0);
  const phase: ImportStage = stage === "fulltext" || stage === "overview" ? stage : "resolving";
  useEffect(() => {
    if (!active) { progress.current = 0; return; }
    const element = fill.current;
    if (!element) return;
    const start = progress.current;
    const startedAt = performance.now();
    let frame: number;
    const draw = (now: number) => {
      progress.current = paperImportProgressAt(start, phase, now - startedAt);
      element.style.width = `${progress.current}%`;
      frame = requestAnimationFrame(draw);
    };
    element.style.width = `${start}%`;
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active, phase]);
  return fill;
}
