import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_STEPS } from "./onboarding-steps";

type CapturedJoyrideProps = {
  options?: {
    skipScroll?: boolean;
  };
  steps: Array<{
    id?: string;
    target: string;
    spotlightTarget?: string;
    content?: unknown;
  }>;
  onEvent: (event: {
    status: string;
    action: string;
    type: string;
    index: number;
  }) => void;
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

describe("onboarding tour", () => {
  beforeEach(() => {
    joyride.props = null;
  });

  it("keeps spreadsheet ribbon features separate from Agent capabilities", () => {
    render(
      <OnboardingTour
        active
        stepIndex={TUTORIAL_STEPS.spreadsheet}
        onStepIndexChange={vi.fn()}
        onSkip={vi.fn()}
        onComplete={vi.fn()}
        onSelectTutorialFile={vi.fn()}
      />,
    );

    expect(joyride.props?.options).toMatchObject({ skipScroll: true });
    const spreadsheet = joyride.props!.steps[TUTORIAL_STEPS.spreadsheet];
    expect(spreadsheet).toMatchObject({
      id: "spreadsheet",
      spotlightTarget: '[data-tour="spreadsheet-workspace"]',
    });
    expect(spreadsheet.content).toContain("co-authors’ selections and pointers");

    const tools = joyride.props!.steps[TUTORIAL_STEPS.spreadsheetTools];
    expect(tools).toMatchObject({
      id: "spreadsheet-tools",
      target: '[data-u-comp="ribbon-toolbar"]',
    });
    expect(tools.content).toContain("Formulas in the toolbar");
    expect(tools.content).toContain("export the spreadsheet as an .xlsx file");
    expect(tools.content).not.toContain("Agent");

    const presentation = joyride.props!.steps[TUTORIAL_STEPS.presentation];
    expect(presentation).toMatchObject({
      id: "presentation",
      spotlightTarget: '[data-tour="presentation-editor"]',
    });
    expect(presentation.content).toContain("Write slides in Markdown");
    expect(presentation.content).toContain("Notes:");
    expect(presentation.content).toContain("style, present, or export");

    const agent = joyride.props!.steps[TUTORIAL_STEPS.agent];
    expect(agent.content).toContain("spreadsheets, and presentations");
    expect(agent.content).toContain("bundled presentation skill");
  });

  it("explains collaboration, Overleaf sync, and the paper PDF actions at their controls", () => {
    const onStepIndexChange = vi.fn();
    render(
      <OnboardingTour
        active
        stepIndex={TUTORIAL_STEPS.workspaceActions}
        onStepIndexChange={onStepIndexChange}
        onSkip={vi.fn()}
        onComplete={vi.fn()}
        onSelectTutorialFile={vi.fn()}
      />,
    );

    const workspace = joyride.props!.steps[TUTORIAL_STEPS.workspaceActions];
    expect(workspace).toMatchObject({
      id: "workspace-actions",
      target: '[data-tour="workspace-actions"]',
    });
    expect(workspace.content).toContain("Live collaboration");
    expect(workspace.content).toContain("Overleaf opens or syncs");

    const paperActions = joyride.props!.steps[TUTORIAL_STEPS.paperActions];
    expect(paperActions).toMatchObject({
      id: "paper-actions",
      target: '[data-tour="paper-actions"]',
    });
    expect(paperActions.content).toContain("original PDF in Lattice");
    expect(paperActions.content).toContain("external-link button");

    act(() => joyride.props!.onEvent({
      status: "running",
      action: "next",
      type: "step:after",
      index: TUTORIAL_STEPS.paperFullText,
    }));
    expect(onStepIndexChange).toHaveBeenCalledWith(TUTORIAL_STEPS.paperActions);
  });

  it("opens the sample sheet and presentation before returning to the manuscript", () => {
    const onSelectTutorialFile = vi.fn();
    const onStepIndexChange = vi.fn();
    render(
      <OnboardingTour
        active
        stepIndex={TUTORIAL_STEPS.board}
        onStepIndexChange={onStepIndexChange}
        onSkip={vi.fn()}
        onComplete={vi.fn()}
        onSelectTutorialFile={onSelectTutorialFile}
      />,
    );

    act(() => joyride.props!.onEvent({
      status: "running",
      action: "next",
      type: "step:after",
      index: TUTORIAL_STEPS.board,
    }));
    expect(onSelectTutorialFile).toHaveBeenCalledWith(
      "attention-results.lattice-sheet",
      TUTORIAL_STEPS.spreadsheet,
    );

    act(() => joyride.props!.onEvent({
      status: "running",
      action: "next",
      type: "step:after",
      index: TUTORIAL_STEPS.spreadsheet,
    }));
    expect(onStepIndexChange).toHaveBeenCalledWith(TUTORIAL_STEPS.spreadsheetTools);

    act(() => joyride.props!.onEvent({
      status: "running",
      action: "next",
      type: "step:after",
      index: TUTORIAL_STEPS.spreadsheetTools,
    }));
    expect(onSelectTutorialFile).toHaveBeenCalledWith(
      "attention-talk.slides.md",
      TUTORIAL_STEPS.presentation,
    );

    act(() => joyride.props!.onEvent({
      status: "running",
      action: "next",
      type: "step:after",
      index: TUTORIAL_STEPS.presentation,
    }));
    expect(onSelectTutorialFile).toHaveBeenCalledWith(
      "main.tex",
      TUTORIAL_STEPS.workspaceActions,
    );
  });
});
