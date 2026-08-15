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

describe("onboarding spreadsheet tour", () => {
  beforeEach(() => {
    joyride.props = null;
  });

  it("introduces spreadsheet editing, collaboration, formulas, export, and Agent tools", () => {
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
    expect(tools.content).toContain("export as .xlsx");
    expect(tools.content).toContain("read and update ranges, formulas, and formatting");
  });

  it("opens the sample sheet after the board and returns to the manuscript afterward", () => {
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
      "main.tex",
      TUTORIAL_STEPS.workspaceActions,
    );
  });
});
