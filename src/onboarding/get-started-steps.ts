/**
 * The Get started checklist's six steps, in the order a first paper needs
 * them: LaTeX on this Mac, a visible build, the PDF↔source jump, a citation,
 * the Agent, and a paper of the writer's own.
 *
 * Each step names what it is and one sentence of why. That sentence is the
 * onboarding exception to the interface's no-helper-text rule
 * (docs/design-system.md): a first-time writer needs it, and it lives only
 * here. Where a step's place is on screen, "Show me" reveals it (`reveal`)
 * and rings it (`target`, read every frame because panels move) without
 * dimming anything. Steps are marked done where they really happen (see
 * get-started-progress.ts), never by a click near them.
 */
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
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

export const GET_STARTED: readonly GetStartedStep[] = [
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
      : msg`Edit the \\title line in main.tex and press ⌘S to see the PDF beside it update in about a second.`,
    hint: import.meta.env.LATTICE_WEB_DEMO ? msg`Press Build` : msg`Edit the title, then press ⌘S`,
    reveal: (context) => void titleLine(context.controller).then((line) => showManuscript(context, line)),
    target: ({ controller }) => manuscriptPanel(controller),
  },
  {
    id: "jump",
    title: msg`Jump between PDF and source`,
    why: msg`Double-click any sentence in the PDF to land on the line that wrote it, and press ⌘⇧J to jump back.`,
    hint: msg`Double-click a sentence`,
    reveal: ({ controller }) => controller.showPanel("pdf", { focus: false }),
    target: ({ controller }) => panelOf(controller, "pdf"),
  },
  {
    id: "cite",
    title: msg`Cite a paper`,
    why: msg`In the editor, press ⌘⇧K and pick one of this project’s papers, or add your own in Papers by arXiv ID, DOI or title.`,
    hint: msg`Click in the text, then press ⌘⇧K`,
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
