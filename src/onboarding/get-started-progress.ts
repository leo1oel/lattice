/**
 * How far the writer has come through the Get started checklist: the steps
 * done and the ones skipped, kept for the writer (every window and every
 * project share it) so the checklist picks up where it was left.
 *
 * Small and eager on purpose. The places where a step really happens (a
 * sample build with a title of the writer's own, a citation inserted, a
 * SyncTeX jump landing, an Agent turn starting or an annotation answered,
 * another project entered) mark it here as they happen, whether or not the
 * checklist panel is open; the panel itself loads only when shown.
 */
import { sharedSetting } from "../settings/shared-setting";
import type { TrellisController } from "../trellis/trellis-controller";

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

/** The sample's manuscript (src-tauri/templates/tutorial/main.tex), and the \title line it ships with. */
export const SAMPLE_MANUSCRIPT = "main.tex";
const SAMPLE_TITLE = "\\title{Understanding Attention: A Worked Guide to Transformer Reasoning}";

export const isTitle = (line: string) => line.trimStart().startsWith("\\title{");

/** The open project's manuscript as it reads now (the editor's text while it is open), or null. */
export async function readSampleManuscript(controller: TrellisController): Promise<string | null> {
  return await controller.bridge?.readText(SAMPLE_MANUSCRIPT) ?? null;
}

/**
 * The build step, watched for the window's life, checklist shown or not; a
 * build counts only while `sampleOpen` says the sample is the project. A build under the title the sample ships with proves nothing was tried: the
 * step waits for a build that succeeds with a title of the writer's own,
 * whenever it was written. The demo's copy fails on a typo it ships with on
 * the first Build asked for, so there the step is a success after a failure:
 * the error read and fixed.
 */
export function watchGetStartedBuild(controller: TrellisController, sampleOpen: () => boolean): () => void {
  let last = controller.docTools.get().lastBuild;
  let failed = false;
  return controller.docTools.subscribe(() => {
    const build = controller.docTools.get().lastBuild;
    if (build === last || !build) return;
    last = build;
    if (!sampleOpen()) return;
    if (build.status === "failed") failed = true;
    if (build.status !== "succeeded") return;
    if (import.meta.env.LATTICE_WEB_DEMO) {
      if (failed) markGetStartedStep("build");
      return;
    }
    void readSampleManuscript(controller).then((text) => {
      const title = text?.split("\n").find(isTitle);
      if (title !== undefined && title.trim() !== SAMPLE_TITLE) markGetStartedStep("build");
    });
  });
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
