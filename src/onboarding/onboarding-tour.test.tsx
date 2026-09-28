import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_STEPS } from "./onboarding-steps";

type CapturedJoyrideProps = {
  options?: { skipScroll?: boolean };
  steps: Array<{ id?: string; target: string; spotlightTarget?: string; content?: unknown }>;
  onEvent: (event: { status: string; action: string; type: string; index: number }) => void;
};

const joyride = vi.hoisted(() => ({ props: null as CapturedJoyrideProps | null }));

vi.mock("react-joyride", () => ({
  ACTIONS: { CLOSE: "close", NEXT: "next", PREV: "prev", SKIP: "skip" },
  EVENTS: { STEP_AFTER: "step:after", TARGET_NOT_FOUND: "target:not-found" },
  STATUS: { FINISHED: "finished", SKIPPED: "skipped" },
  Joyride: (props: CapturedJoyrideProps) => {
    joyride.props = props;
    return null;
  },
}));

import { OnboardingTour } from "./onboarding-tour";

function renderTour(stepIndex: number) {
  const callbacks = { onStepIndexChange: vi.fn(), onSkip: vi.fn(), onComplete: vi.fn(), onSelectTutorialFile: vi.fn() };
  render(<OnboardingTour active stepIndex={stepIndex} {...callbacks} />);
  return callbacks;
}

const continueFrom = (index: number) =>
  act(() => joyride.props!.onEvent({ status: "running", action: "next", type: "step:after", index }));

describe("onboarding tour", () => {
  beforeEach(() => {
    joyride.props = null;
  });

  it.each([
    ["spreadsheet", { id: "spreadsheet", spotlightTarget: '[data-tour="spreadsheet-workspace"]' },
      ["Edit cells and formulas directly"], ["co-authors"]],
    // Spreadsheet ribbon features stay separate from Agent capabilities.
    ["spreadsheetTools", { id: "spreadsheet-tools", target: '[data-u-comp="ribbon-toolbar"]' },
      ["Formulas in the toolbar", "export the spreadsheet as an .xlsx file"], ["Agent"]],
    ["presentationCreate", { id: "presentation-create", target: '[data-tour="new-document"]', title: "Create with the + menu" },
      ["presentation, spreadsheet, or board"], ["tutorial already includes"]],
    ["presentation", { id: "presentation", spotlightTarget: '[data-tour="open-slide-workspace"]', title: "Edit an Open Slide presentation" },
      ["thumbnail rail", "Inspect or Design", "Present to show it", "React and TSX"], []],
    ["agent", { id: "agent" }, ["Open Slide presentations", "build slides"], []],
    // Overleaf sync and the paper PDF actions are explained at their controls.
    ["workspaceActions", { id: "workspace-actions", target: '[data-tour="workspace-actions"]' },
      ["Overleaf opens or syncs"], ["Live collaboration"]],
    ["paperActions", { id: "paper-actions", target: '[data-tour="paper-actions"]' },
      ["original PDF in Lattice", "external-link button"], []],
  ] as const)("describes the %s step", (name, shape, included, excluded) => {
    renderTour(TUTORIAL_STEPS[name]);
    expect(joyride.props?.options).toMatchObject({ skipScroll: true });
    const step = joyride.props!.steps[TUTORIAL_STEPS[name]];
    expect(step).toMatchObject(shape);
    for (const text of included) expect(step.content).toContain(text);
    for (const text of excluded) expect(step.content).not.toContain(text);
  });

  it.each([
    // Opens the editable tutorial deck and returns to the manuscript afterward.
    [TUTORIAL_STEPS.presentationCreate, "slides/understanding-attention/index.tsx", TUTORIAL_STEPS.presentation],
    [TUTORIAL_STEPS.presentation, "main.tex", TUTORIAL_STEPS.viewModes],
    // Opens the sample sheet before returning to the manuscript.
    [TUTORIAL_STEPS.board, "attention-results.lattice-sheet", TUTORIAL_STEPS.spreadsheet],
    [TUTORIAL_STEPS.spreadsheetTools, "main.tex", TUTORIAL_STEPS.workspaceActions],
  ])("continuing from step %i opens %s for step %i", (from, path, to) => {
    const { onSelectTutorialFile, onStepIndexChange } = renderTour(from);
    continueFrom(from);
    expect(onSelectTutorialFile).toHaveBeenCalledWith(path, to);
    expect(onStepIndexChange).not.toHaveBeenCalled();
  });

  it.each([
    [TUTORIAL_STEPS.spreadsheet, TUTORIAL_STEPS.spreadsheetTools],
    [TUTORIAL_STEPS.paperFullText, TUTORIAL_STEPS.paperActions],
  ])("continuing from step %i advances to step %i without opening a file", (from, to) => {
    const { onSelectTutorialFile, onStepIndexChange } = renderTour(from);
    continueFrom(from);
    expect(onStepIndexChange).toHaveBeenCalledWith(to);
    expect(onSelectTutorialFile).not.toHaveBeenCalled();
  });

  it("drops the previous paper-blog spotlight when the reader comes back to that step", async () => {
    const targets = document.createElement("div");
    targets.innerHTML = '<div data-tour="paper-reading-view"></div><div class="paper-content-switcher"><button data-tour="paper-fulltext"></button></div>';
    document.body.append(targets);
    const nextFrame = () => act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    const rings = () => Array.from(document.querySelectorAll(".lattice-tour-dual-spotlight-ring"), (ring) => ring.getAttribute("d"));
    const callbacks = { onStepIndexChange: vi.fn(), onSkip: vi.fn(), onComplete: vi.fn(), onSelectTutorialFile: vi.fn() };
    const { rerender } = render(<OnboardingTour active stepIndex={TUTORIAL_STEPS.paperBlog} {...callbacks} />);
    await nextFrame();
    expect(rings().every((d) => d?.startsWith("M "))).toBe(true);

    rerender(<OnboardingTour active stepIndex={TUTORIAL_STEPS.paperFullText} {...callbacks} />);
    targets.remove();
    rerender(<OnboardingTour active stepIndex={TUTORIAL_STEPS.paperBlog} {...callbacks} />);
    await nextFrame();
    expect(rings()).toEqual([null, null]);
  });
});
