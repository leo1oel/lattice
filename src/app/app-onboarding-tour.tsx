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
import { isOpenSlideDeckPath } from "../app-utils";
import type { CanvasMode, EditorPaneId } from "../app-types";

const OnboardingTour = lazy(() =>
  import("../onboarding/onboarding-tour").then((module) => ({ default: module.OnboardingTour })),
);

export type AppOnboardingTourProps = {
  activeFile: string;
  activePaperPath: string | null;
  canvasMode: CanvasMode;
  changePaperView: (view: "blog" | "fulltext") => void;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
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

export function AppOnboardingTour(props: AppOnboardingTourProps) {
  const {
    activeFile,
    activePaperPath,
    canvasMode,
    changePaperView,
    openProjectFile,
    setCanvasMode,
    setCollabOpen,
    setGitOpen,
    setOverleafPickerOpen,
    setSidebarMode,
    setSidebarOpen,
    setTutorialActive,
    setTutorialStep,
    tutorialActive,
    tutorialStep,
  } = props;
  return (
    <>
      {tutorialActive && (
        <Suspense fallback={null}>
          <OnboardingTour
            // Only the canvas mode remounts the tour. Remounting per step made
            // every advance re-resolve the step's target from cold, which is a
            // race against the canvas that the step is pointing at; Joyride
            // takes `stepIndex` as a controlled prop and moves itself.
            key={`tutorial:${canvasMode}`}
            active
            stepIndex={tutorialStep}
            onSelectTutorialFile={(path, nextStep) => {
              let mode: CanvasMode = "split";
              if (
                isOpenSlideDeckPath(path)
                || path.endsWith(".tldr")
                || path.endsWith(".lattice-sheet")
              ) {
                mode = "source";
              } else if (path.endsWith(".html")) {
                mode = "pdf";
              }
              void openProjectFile(path).then(() => {
                setCanvasMode(mode);
                setTutorialStep(nextStep);
              });
            }}
            onStepIndexChange={(nextStep) => {
              const openTutorialDocument = async (path: string, mode: CanvasMode) => {
                // Re-opening the document a step already shows tears the canvas
                // down and rebuilds it — including the element that step
                // spotlights — while Joyride is measuring it, which parks the
                // tour on a full-screen overlay with no cutout and no card.
                // Going forward always arrives with the right document open;
                // only Back returns from a different file.
                if (!activePaperPath && activeFile === path && canvasMode === mode) {
                  setTutorialStep(nextStep);
                  return;
                }
                await openProjectFile(path);
                setCanvasMode(mode);
                setTutorialStep(nextStep);
              };
              if (nextStep === TUTORIAL_STEPS.latex) {
                void openTutorialDocument("main.tex", "split");
              } else if (nextStep === TUTORIAL_STEPS.presentation) {
                void openTutorialDocument("slides/understanding-attention/index.tsx", "source");
              } else if (nextStep === TUTORIAL_STEPS.viewModes) {
                void openTutorialDocument("main.tex", "split");
              } else if (nextStep === TUTORIAL_STEPS.markdown || nextStep === TUTORIAL_STEPS.markdownVisual) {
                void openTutorialDocument("notes.md", "split");
              } else if (nextStep === TUTORIAL_STEPS.html) {
                void openTutorialDocument("attention-demo.html", "pdf");
              } else if (nextStep === TUTORIAL_STEPS.board) {
                void openTutorialDocument("attention-map.tldr", "source");
              } else if (nextStep === TUTORIAL_STEPS.spreadsheet || nextStep === TUTORIAL_STEPS.spreadsheetTools) {
                void openTutorialDocument("attention-results.lattice-sheet", "source");
              } else if (nextStep === TUTORIAL_STEPS.workspaceActions) {
                void openTutorialDocument("main.tex", "split");
              } else if (nextStep === TUTORIAL_STEPS.paperBlog) {
                changePaperView("blog");
                setTutorialStep(nextStep);
              } else if (nextStep === TUTORIAL_STEPS.paperFullText) {
                changePaperView("fulltext");
                setTutorialStep(nextStep);
              } else {
                setTutorialStep(nextStep);
              }
            }}
            onSkip={() => {
              markTutorialSeen();
              setCollabOpen(false);
              setOverleafPickerOpen(false);
              setGitOpen(false);
              setTutorialActive(false);
            }}
            onComplete={() => {
              markTutorialSeen();
              setCollabOpen(false);
              setOverleafPickerOpen(false);
              setGitOpen(false);
              setTutorialActive(false);
              setSidebarMode("project");
              setSidebarOpen(true);
              void openProjectFile("main.tex").then(() => {
                setCanvasMode("split");
                setNotice("Tutorial finished · keep poking around this project, or start one of your own.");
              });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
