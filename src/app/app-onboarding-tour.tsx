/**
 * The guided tutorial overlay. It drives the app rather than reading it: every
 * step opens the document it is about and picks the canvas mode that shows the
 * feature, so most of its props are the same navigation actions the command
 * surfaces use.
 */
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { markTutorialSeen } from "../settings/app-settings";
import { TUTORIAL_STEPS } from "../onboarding/onboarding-steps";
import { setNotice } from "./notify";
import { isHtmlFilePath, isWholeFileEditorPath } from "../app-utils";
import type { CanvasMode, OpenProjectFile } from "../app-types";

const OnboardingTour = lazy(() =>
  import("../onboarding/onboarding-tour").then((module) => ({ default: module.OnboardingTour })),
);

export type AppOnboardingTourProps = {
  activeFile: string;
  activePaperPath: string | null;
  canvasMode: CanvasMode;
  changePaperView: (view: "blog" | "fulltext") => void;
  openProjectFile: OpenProjectFile;
  setCanvasMode: Dispatch<SetStateAction<CanvasMode>>;
  setCollabOpen: Dispatch<SetStateAction<boolean>>;
  setGitOpen: Dispatch<SetStateAction<boolean>>;
  setOverleafPickerOpen: Dispatch<SetStateAction<boolean>>;
  setSidebarMode: Dispatch<SetStateAction<"agent" | "project" | "papers">>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setTutorialActive: Dispatch<SetStateAction<boolean>>;
  setTutorialStep: Dispatch<SetStateAction<number>>;
  tutorialActive: boolean;
  tutorialStep: number;
};

/** The tutorial document each step is about; `tutorialModeFor` picks the canvas mode that shows it. */
const STEP_DOCUMENTS = new Map<number, string>([
  [TUTORIAL_STEPS.latex, "main.tex"],
  [TUTORIAL_STEPS.presentation, "slides/understanding-attention/index.tsx"],
  [TUTORIAL_STEPS.viewModes, "main.tex"],
  [TUTORIAL_STEPS.markdown, "notes.md"],
  [TUTORIAL_STEPS.markdownVisual, "notes.md"],
  [TUTORIAL_STEPS.html, "attention-demo.html"],
  [TUTORIAL_STEPS.board, "attention-map.tldr"],
  [TUTORIAL_STEPS.spreadsheet, "attention-results.lattice-sheet"],
  [TUTORIAL_STEPS.spreadsheetTools, "attention-results.lattice-sheet"],
  [TUTORIAL_STEPS.workspaceActions, "main.tex"],
]);
const STEP_PAPER_VIEWS = new Map<number, "blog" | "fulltext">([
  [TUTORIAL_STEPS.paperBlog, "blog"],
  [TUTORIAL_STEPS.paperFullText, "fulltext"],
]);

/** Whole-document editors own the canvas; HTML reads best as its preview. */
function tutorialModeFor(path: string): CanvasMode {
  return isWholeFileEditorPath(path) ? "source" : isHtmlFilePath(path) ? "pdf" : "split";
}

export function AppOnboardingTour(props: AppOnboardingTourProps) {
  const { canvasMode, openProjectFile, setCanvasMode, setTutorialStep } = props;
  if (!props.tutorialActive) return null;
  const openAndAdvance = (path: string, nextStep: number) => openProjectFile(path).then(() => {
    setCanvasMode(tutorialModeFor(path));
    setTutorialStep(nextStep);
  });
  const endTutorial = () => {
    markTutorialSeen();
    props.setCollabOpen(false);
    props.setOverleafPickerOpen(false);
    props.setGitOpen(false);
    props.setTutorialActive(false);
  };
  return (
    <Suspense fallback={null}>
      <OnboardingTour
        // Only the canvas mode remounts the tour. Remounting per step made
        // every advance re-resolve the step's target from cold, which is a
        // race against the canvas that the step is pointing at; Joyride
        // takes `stepIndex` as a controlled prop and moves itself.
        key={`tutorial:${canvasMode}`}
        active
        stepIndex={props.tutorialStep}
        onSelectTutorialFile={(path, nextStep) => void openAndAdvance(path, nextStep)}
        onStepIndexChange={(nextStep) => {
          const stepDocument = STEP_DOCUMENTS.get(nextStep);
          const paperView = STEP_PAPER_VIEWS.get(nextStep);
          if (paperView) props.changePaperView(paperView);
          // Re-opening the document a step already shows tears the canvas
          // down and rebuilds it — including the element that step
          // spotlights — while Joyride is measuring it, which parks the
          // tour on a full-screen overlay with no cutout and no card.
          // Going forward always arrives with the right document open;
          // only Back returns from a different file.
          if (!stepDocument || (!props.activePaperPath && props.activeFile === stepDocument && canvasMode === tutorialModeFor(stepDocument))) {
            setTutorialStep(nextStep);
            return;
          }
          void openAndAdvance(stepDocument, nextStep);
        }}
        onSkip={endTutorial}
        onComplete={() => {
          endTutorial();
          props.setSidebarMode("project");
          props.setSidebarOpen(true);
          void openProjectFile("main.tex").then(() => {
            setCanvasMode("split");
            setNotice("Tutorial finished · keep poking around this project, or start one of your own.");
          });
        }}
      />
    </Suspense>
  );
}
