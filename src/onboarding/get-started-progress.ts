/**
 * How far the writer has come through the Get started checklist: the steps
 * done and the ones skipped, kept for the writer (every window and every
 * project share it) so the checklist picks up where it was left.
 *
 * Small and eager on purpose. The places where a step really happens (a
 * citation inserted, a SyncTeX jump landing, an Agent turn starting or an
 * annotation answered, another project entered) mark it here as they happen,
 * whether or not the checklist panel is open; the panel itself loads only
 * when shown.
 */
import { sharedSetting } from "../settings/shared-setting";

export const GET_STARTED_STEPS = ["latex", "build", "jump", "cite", "agent", "own"] as const;
export type GetStartedStepId = (typeof GET_STARTED_STEPS)[number];

export type GetStartedProgress = { done: GetStartedStepId[]; skipped: GetStartedStepId[] };

export const GET_STARTED_KEY = "lattice.get-started.v1";

/** The venue `create_tutorial` (src-tauri/src/project/create.rs) gives the sample: any other project is the writer's own. */
export const TUTORIAL_VENUE = "tutorial";

function stepsIn(value: unknown): GetStartedStepId[] {
  return Array.isArray(value) ? GET_STARTED_STEPS.filter((step) => value.includes(step)) : [];
}

function loadProgress(): GetStartedProgress {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(GET_STARTED_KEY) ?? "null");
    const record = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
    return { done: stepsIn(record.done), skipped: stepsIn(record.skipped) };
  } catch {
    return { done: [], skipped: [] };
  }
}

/** Every change below is an updater, so it applies to what another window stored meanwhile. */
export const getStartedProgress = sharedSetting(GET_STARTED_KEY, loadProgress);

/** A step happened: it is done for good, skipped or not. */
export function markGetStartedStep(step: GetStartedStepId) {
  if (getStartedProgress.get().done.includes(step)) return;
  getStartedProgress.set((progress) => ({ ...progress, done: stepsIn([...progress.done, step]) }));
}

export function skipGetStartedStep(step: GetStartedStepId) {
  getStartedProgress.set((progress) => ({ ...progress, skipped: stepsIn([...progress.skipped, step]) }));
}

// Whether this window shows the checklist, kept where the app opens and
// closes it (use-tool-drawers.ts), synchronously, so a build that fails the
// moment the sample opens already knows (see use-tex-setup.ts).
let shown = false;

export function setGetStartedShown(value: boolean) {
  shown = value;
}

/** While shown, a missing TeX is the checklist's first step to report, not the setup dialog's. */
export const isGetStartedShown = () => shown;
