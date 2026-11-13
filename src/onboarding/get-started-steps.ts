/**
 * The Get started checklist's six steps, in the order a first paper needs
 * them: LaTeX on this computer, a visible build, the PDF↔source jump, a
 * citation, the Agent, and a paper of the writer's own.
 *
 * Each step names what it is and one sentence of why. That sentence is the
 * onboarding exception to the interface's no-helper-text rule
 * (docs/design-system.md): a first-time writer needs it, and it lives only
 * here. Where a step's place is on screen, "Show me" reveals it (`reveal`)
 * and rings it (`target`, read every frame because panels move) without
 * dimming anything. Steps are marked done where they really happen (see
 * get-started-progress.ts), never by a click near them.
 */
import { hostPlatform, type HostPlatform } from "../platform/host-platform";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { CITE_KEY, SAVE_KEY } from "../app/command-keys";
import { comboText } from "../app/key-combos";
import { REVEAL_IN_PDF_KEY } from "../pdf/pdf-keys";
import type { TrellisController, TrellisSingleton } from "../trellis/trellis-controller";
import { isTitle, readSampleManuscript, SAMPLE_MANUSCRIPT, type GetStartedStepId } from "./get-started-progress";

export type ShowMeContext = {
  controller: TrellisController;
  openFile: (path: string, options?: { line?: number }) => void;
};

export type GetStartedStep = {
  id: GetStartedStepId;
  title: MessageDescriptor;
  why: MessageDescriptor;
  /** What the ring says over the place "Show me" brings up. */
  hint?: MessageDescriptor;
  reveal?: (context: ShowMeContext) => void;
  target?: (context: ShowMeContext) => DOMRect | null;
};

/** A rect is worth pointing at only when enough of it is on screen. */
function visibleRect(rect: DOMRect | null | undefined): DOMRect | null {
  if (!rect || rect.width < 24 || rect.height < 16) return null;
  if (rect.right < 8 || rect.bottom < 8 || rect.left > window.innerWidth - 8 || rect.top > window.innerHeight - 8) return null;
  return rect;
}

/** The panel holding a singleton view, when that view is the one shown in it. */
function panelOf(controller: TrellisController, kind: TrellisSingleton): DOMRect | null {
  const view = controller.ws?.view(kind);
  if (!view || view.placement === "hidden" || !view.visible) return null;
  return visibleRect(controller.panelRect(kind));
}

function manuscriptPanel(controller: TrellisController): DOMRect | null {
  const view = controller.ws?.views({ type: "file" }).find((item) => item.params.key === SAMPLE_MANUSCRIPT);
  if (!view || view.placement === "hidden" || !view.selected) return null;
  return visibleRect(controller.panelRect(view.id));
}

/** The manuscript's \title line, 1-based, once its text is known. */
async function titleLine(controller: TrellisController): Promise<number | undefined> {
  const index = (await readSampleManuscript(controller))?.split("\n").findIndex(isTitle) ?? -1;
  return index >= 0 ? index + 1 : undefined;
}

const showManuscript = ({ controller, openFile }: ShowMeContext, line?: number) => {
  if (line !== undefined || controller.app.get().activeKey !== SAMPLE_MANUSCRIPT || !manuscriptPanel(controller)) {
    openFile(SAMPLE_MANUSCRIPT, line === undefined ? undefined : { line });
  }
};

/**
 * The keys the steps name, as this host writes them (⌘S, or Ctrl+S), from the
 * combinations their commands bind. A sentence that spelled ⌘⇧J told a Linux
 * writer to press Super, and each host needed a copy of every sentence that
 * names a key.
 */
const stepKeys = () => ({
  saveKeys: comboText({ ...SAVE_KEY, mod: true }),
  jumpKeys: comboText({ ...REVEAL_IN_PDF_KEY, mod: true }),
  citeKeys: comboText({ ...CITE_KEY, mod: true }),
});
type StepKeys = ReturnType<typeof stepKeys>;

/** The steps as the Mac reads them. */
const GET_STARTED = ({ saveKeys, jumpKeys, citeKeys }: StepKeys): readonly GetStartedStep[] => [
  {
    id: "latex",
    title: msg`Install LaTeX`,
    why: msg`Lattice builds your PDF with the LaTeX on this Mac, and BasicTeX is about 1 GB.`,
  },
  {
    id: "build",
    title: import.meta.env.LATTICE_WEB_DEMO ? msg`Build, then fix an error` : msg`Change the title, then build`,
    why: import.meta.env.LATTICE_WEB_DEMO
      ? msg`Press Build, read how Lattice explains the typo this copy has on purpose, apply the fix, and build again.`
      : msg`Edit the \\title line in main.tex and press ${saveKeys} to see the PDF beside it update in about a second.`,
    hint: import.meta.env.LATTICE_WEB_DEMO ? msg`Press Build` : msg`Edit the title, then press ${saveKeys}`,
    reveal: (context) => void titleLine(context.controller).then((line) => showManuscript(context, line)),
    target: ({ controller }) => manuscriptPanel(controller),
  },
  {
    id: "jump",
    title: msg`Jump between PDF and source`,
    why: msg`Double-click any sentence in the PDF to land on the line that wrote it, and press ${jumpKeys} to jump back.`,
    hint: msg`Double-click a sentence`,
    reveal: ({ controller }) => controller.showPanel("pdf", { focus: false }),
    target: ({ controller }) => panelOf(controller, "pdf"),
  },
  {
    id: "cite",
    title: msg`Cite a paper`,
    why: msg`In the editor, press ${citeKeys} and pick one of this project’s papers, or add your own in Papers by arXiv ID, DOI or title.`,
    hint: msg`Click in the text, then press ${citeKeys}`,
    reveal: (context) => showManuscript(context),
    target: ({ controller }) => manuscriptPanel(controller),
  },
  {
    id: "agent",
    title: msg`Ask the Agent to revise`,
    why: import.meta.env.LATTICE_WEB_DEMO
      ? msg`Download Lattice to try the Agent, which runs on your Mac with Claude Code or Codex.`
      : msg`Select a paragraph, choose Annotate, write what should change, then Save and revise now.`,
    hint: msg`Check that an agent is connected`,
    reveal: ({ controller }) => controller.showPanel("agent", { focus: false }),
    target: ({ controller }) => panelOf(controller, "agent"),
  },
  {
    id: "own",
    title: msg`Start your own paper`,
    why: import.meta.env.LATTICE_WEB_DEMO
      ? msg`Download Lattice for Mac to write your own, from a venue template or an Overleaf project.`
      : msg`Start from a venue template, open a folder on this Mac, or bring a project from Overleaf.`,
  },
];

/** What a host's checklist leaves out, and what a step says differently there. */
type HostSteps = {
  without: readonly GetStartedStepId[];
  rewrite: (id: GetStartedStepId, keys: StepKeys) => Partial<GetStartedStep> | undefined;
};

const ANOTHER_COMPUTER = msg`Start from a venue template, open a folder on this computer, or bring a project from Overleaf.`;

/**
 * One row per host. The embedded agent is not supported on the experimental
 * Windows host or on Linux, and neither installs BasicTeX: Windows has TeX
 * Live's own installer, Linux the distribution's packages.
 */
const HOST_STEPS: Record<HostPlatform, HostSteps> = {
  mac: { without: [], rewrite: () => undefined },
  windows: {
    without: ["agent"],
    rewrite: (id, { saveKeys }) => {
      switch (id) {
        case "latex": return { why: msg`Install TeX Live for Windows to build your PDF. You can keep editing before installing LaTeX.` };
        case "build": return { why: msg`Edit the title line in main.tex and press ${saveKeys} to update the PDF beside it.` };
        case "own": return { why: ANOTHER_COMPUTER };
        default: return undefined;
      }
    },
  },
  linux: {
    without: ["agent"],
    rewrite: (id) => {
      switch (id) {
        case "latex": return { why: msg`Lattice builds your PDF with the TeX Live on this computer. Install it from your distribution’s packages.` };
        case "own": return { why: ANOTHER_COMPUTER };
        default: return undefined;
      }
    },
  },
};

/** Built once per host: the panel asks on every render, and a test may be each host in turn. */
const stepsByHost = new Map<HostPlatform, readonly GetStartedStep[]>();

export function getStartedSteps(): readonly GetStartedStep[] {
  const host = hostPlatform();
  let steps = stepsByHost.get(host);
  if (!steps) {
    const { without, rewrite } = HOST_STEPS[host];
    const keys = stepKeys();
    steps = GET_STARTED(keys).filter((step) => !without.includes(step.id)).map((step) => ({ ...step, ...rewrite(step.id, keys) }));
    stepsByHost.set(host, steps);
  }
  return steps;
}
