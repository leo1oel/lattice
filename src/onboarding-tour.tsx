import { ArrowLeft, ArrowRight, MousePointer2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIONS,
  EVENTS,
  Joyride,
  STATUS,
  type EventData,
  type Step,
  type TooltipRenderProps,
} from "react-joyride";
import { TUTORIAL_STEPS } from "./onboarding-steps";

const ACTION_BUTTONS: Step["buttons"] = ["back", "skip"];
const READING_BUTTONS: Step["buttons"] = ["back", "skip", "primary"];

/* ─────────────────────────────────────────────────────────
 * TUTORIAL POINTER STORYBOARD
 *
 *    0ms   pointer appears beside the current tour card
 *   40ms   pointer travels to the real control
 *  560ms   pointer presses the control
 *  680ms   control activates and pointer fades
 * ───────────────────────────────────────────────────────── */
const POINTER_TIMING = {
  startMove: 40,
  press: 560,
  activate: 680,
  hide: 860,
  markdownReady: 650,
} as const;

type TutorialPointerState = {
  visible: boolean;
  pressed: boolean;
  x: number;
  y: number;
};

function roundedSpotlightPath(rect: DOMRect, padding = 8, radius = 10): string {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  const right = Math.min(window.innerWidth, rect.right + padding);
  const bottom = Math.min(window.innerHeight, rect.bottom + padding);
  const corner = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  return [
    `M ${left + corner} ${top}`,
    `H ${right - corner}`,
    `Q ${right} ${top} ${right} ${top + corner}`,
    `V ${bottom - corner}`,
    `Q ${right} ${bottom} ${right - corner} ${bottom}`,
    `H ${left + corner}`,
    `Q ${left} ${bottom} ${left} ${bottom - corner}`,
    `V ${top + corner}`,
    `Q ${left} ${top} ${left + corner} ${top}`,
    "Z",
  ].join(" ");
}

function projectTreeFile(path: string): HTMLElement | null {
  const root = document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot;
  return Array.from(root?.querySelectorAll<HTMLElement>("button[data-item-path]") ?? [])
    .find((item) => item.dataset.itemPath === path) ?? null;
}

function markdownBlockForTour(): HTMLElement | null {
  const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Markdown document editor"]');
  if (!editor) return null;
  const viewport = editor.closest<HTMLElement>('[data-tour="markdown-visual-editor"]')?.getBoundingClientRect()
    ?? editor.getBoundingClientRect();
  const center = viewport.top + viewport.height / 2;
  return Array.from(editor.children).filter((child): child is HTMLElement => {
    const rect = child.getBoundingClientRect();
    return child instanceof HTMLElement
      && rect.width > 0
      && rect.height > 0
      && rect.bottom > viewport.top + 24
      && rect.top < viewport.bottom - 24;
  }).sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return Math.abs((aRect.top + aRect.bottom) / 2 - center)
      - Math.abs((bRect.top + bRect.bottom) / 2 - center);
  })[0] ?? null;
}

function closeMarkdownSlashMenu() {
  const menu = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Slash commands"]');
  if (!menu) return;
  const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Markdown document editor"]');
  editor?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  }));
}

function LatticeTourTooltip(props: TooltipRenderProps) {
  const { backProps, index, isLastStep, primaryProps, size, skipProps, step } = props;
  const canGoBack = step.buttons.includes("back") && index > 0;
  const canContinue = step.buttons.includes("primary");
  const canSkip = step.buttons.includes("skip") && !isLastStep;
  const action = step.data?.action as string | undefined;

  return (
    <section
      className="lattice-tour"
      role="dialog"
      aria-modal="false"
      aria-labelledby="lattice-tour-title"
      aria-describedby="lattice-tour-content"
      data-joyride-step={index}
    >
      <header className="lattice-tour-header">
        <span className="lattice-tour-mark" aria-hidden="true"><Sparkles size={15} /></span>
        <span className="lattice-tour-kicker">{index + 1} / {size}</span>
        {canSkip && (
          <button className="lattice-tour-skip" type="button" {...skipProps}>Skip tour</button>
        )}
      </header>
      <progress className="lattice-tour-progress" max={size} value={index + 1} aria-label={`Tutorial progress: step ${index + 1} of ${size}`} />
      <div className="lattice-tour-body">
        {step.title && <h2 id="lattice-tour-title">{step.title}</h2>}
        <div id="lattice-tour-content" className="lattice-tour-copy">{step.content}</div>
        {action && (
          <div className="lattice-tour-action">
            <MousePointer2 size={14} aria-hidden="true" />
            <span>{action}</span>
          </div>
        )}
      </div>
      {(canGoBack || canContinue) && (
        <footer className="lattice-tour-footer">
          {canGoBack ? (
            <button className="lattice-tour-button secondary" type="button" {...backProps}>
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </button>
          ) : <span />}
          {canContinue && (
            <button className="lattice-tour-button primary" type="button" {...primaryProps}>
              {isLastStep ? "Finish" : "Continue"}
              {!isLastStep && <ArrowRight size={14} aria-hidden="true" />}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

export function OnboardingTour(props: {
  active: boolean;
  stepIndex: number;
  onStepIndexChange: (index: number) => void;
  onSkip: () => void;
  onComplete: () => void;
  onSelectTutorialFile: (path: string, stepIndex: number) => void;
}) {
  const pointerTimersRef = useRef<number[]>([]);
  const pointerRunningRef = useRef(false);
  const [pointer, setPointer] = useState<TutorialPointerState>({
    visible: false,
    pressed: false,
    x: 0,
    y: 0,
  });
  const paperBlogSpotlightRef = useRef<SVGSVGElement>(null);
  const paperBlogMaskRef = useRef<SVGPathElement>(null);
  const paperBlogReadingRingRef = useRef<SVGPathElement>(null);
  const paperBlogSwitcherRingRef = useRef<SVGPathElement>(null);

  const updatePaperBlogSpotlight = useCallback(() => {
    const spotlight = paperBlogSpotlightRef.current;
    const mask = paperBlogMaskRef.current;
    const readingRing = paperBlogReadingRingRef.current;
    const switcherRing = paperBlogSwitcherRingRef.current;
    const readingView = document.querySelector<HTMLElement>('[data-tour="paper-reading-view"]');
    const paperTarget = document.querySelector<HTMLElement>('[data-tour="paper-fulltext"]');
    const switchTarget = paperTarget?.closest<HTMLElement>(".paper-content-switcher") ?? paperTarget;
    if (!spotlight || !mask || !readingRing || !switcherRing || !readingView || !switchTarget) return;
    const readingRect = readingView.getBoundingClientRect();
    const switchRect = switchTarget.getBoundingClientRect();
    const readingPath = roundedSpotlightPath(readingRect);
    const switcherPath = roundedSpotlightPath(switchRect, 6, 8);
    spotlight.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    mask.setAttribute("d", `${readingPath} ${switcherPath}`);
    readingRing.setAttribute("d", readingPath);
    switcherRing.setAttribute("d", switcherPath);
  }, []);

  const clearPointerTimers = useCallback(() => {
    pointerTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    pointerTimersRef.current = [];
  }, []);

  const animatePointerClick = useCallback((target: HTMLElement, activate: () => void) => {
    if (pointerRunningRef.current) return;
    pointerRunningRef.current = true;
    clearPointerTimers();
    const targetRect = target.getBoundingClientRect();
    const originRect = document.querySelector<HTMLElement>(".lattice-tour")?.getBoundingClientRect();
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reducedMotion) {
      activate();
      pointerRunningRef.current = false;
      return;
    }
    setPointer({
      visible: true,
      pressed: false,
      x: originRect ? originRect.left + 24 : window.innerWidth / 2,
      y: originRect ? originRect.top + 24 : window.innerHeight / 2,
    });
    pointerTimersRef.current.push(
      window.setTimeout(() => setPointer((current) => ({
        ...current,
        x: targetRect.left + targetRect.width / 2,
        y: targetRect.top + targetRect.height / 2,
      })), POINTER_TIMING.startMove),
      window.setTimeout(() => setPointer((current) => ({ ...current, pressed: true })), POINTER_TIMING.press),
      window.setTimeout(() => {
        activate();
        setPointer((current) => ({ ...current, pressed: false }));
      }, POINTER_TIMING.activate),
      window.setTimeout(() => {
        setPointer((current) => ({ ...current, visible: false }));
        pointerRunningRef.current = false;
      }, POINTER_TIMING.hide),
    );
  }, [clearPointerTimers]);

  useEffect(() => {
    document.body.classList.add("lattice-tutorial-active");
    return () => {
      document.body.classList.remove("lattice-tutorial-active");
      clearPointerTimers();
    };
  }, [clearPointerTimers]);

  useEffect(() => {
    if (props.stepIndex !== TUTORIAL_STEPS.markdownVisual) return;
    let cancelled = false;
    let attempts = 0;
    const revealAndClickAdd = () => {
      if (cancelled) return;
      const block = markdownBlockForTour();
      if (block) {
        const rect = block.getBoundingClientRect();
        block.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: rect.left + Math.min(48, rect.width / 2),
          clientY: rect.top + Math.min(18, rect.height / 2),
        }));
      }
      const addButton = document.querySelector<HTMLElement>('button.ok-add-block-btn[aria-label="Add block below"]');
      const addRect = addButton?.getBoundingClientRect();
      const blockRect = block?.getBoundingClientRect();
      if (
        addButton
        && addRect
        && blockRect
        && addRect.width > 0
        && addRect.height > 0
        && Math.abs(addRect.top - blockRect.top) < 72
      ) {
        animatePointerClick(addButton, () => addButton.click());
        return;
      }
      attempts += 1;
      if (attempts < 20) pointerTimersRef.current.push(window.setTimeout(revealAndClickAdd, 100));
    };
    pointerTimersRef.current.push(window.setTimeout(revealAndClickAdd, POINTER_TIMING.markdownReady));
    return () => { cancelled = true; };
  }, [animatePointerClick, props.stepIndex]);

  useEffect(() => {
    if (props.stepIndex !== TUTORIAL_STEPS.paperBlog) return;
    let frame = 0;
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePaperBlogSpotlight);
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    const observer = new ResizeObserver(scheduleUpdate);
    const readingView = document.querySelector<HTMLElement>('[data-tour="paper-reading-view"]');
    const switchTarget = document.querySelector<HTMLElement>('[data-tour="paper-fulltext"]');
    if (readingView) observer.observe(readingView);
    if (switchTarget) observer.observe(switchTarget);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      observer.disconnect();
    };
  }, [props.stepIndex, updatePaperBlogSpotlight]);

  const steps = useMemo<Step[]>(() => {
    const viewportFloatingOptions = {
      strategy: "fixed" as const,
      flipOptions: false as const,
      shiftOptions: {
        boundary: document.documentElement,
        rootBoundary: "viewport" as const,
        padding: 12,
      },
    };
    return [{
      id: "welcome",
      target: "body",
      placement: "center",
      title: "Meet the “Attention Is All You Need” project",
      content: "A complete example with a NeurIPS manuscript, notes, references, figures, and an interactive demo.",
      buttons: ["skip", "primary"],
    },
    {
      id: "latex",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="split-workspace"]',
      title: "Write LaTeX beside the finished PDF",
      content: "Edit main.tex on the left. The PDF on the right saves, compiles, and refreshes automatically.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "project-files",
      target: '[data-tour="project-panel"]',
      title: "One project, every research file",
      content: "Open LaTeX, Markdown, HTML, TOML, PDF, images, and boards from the project tree.",
      buttons: READING_BUTTONS,
      placement: "right-start",
    },
    {
      id: "view-modes",
      target: '[data-tour="document-view"]',
      title: "Choose how you want to work",
      content: "Switch between Edit, Split, and Preview at any time.",
      buttons: READING_BUTTONS,
      placement: "bottom",
      spotlightPadding: 5,
    },
    {
      id: "markdown",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="split-workspace"]',
      title: "Keep research notes in Markdown",
      content: "Edit notes.md on the left and review the formatted result on the right.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "markdown-visual",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="markdown-visual-editor"]',
      title: "Edit the formatted document directly",
      content: "Select text to edit it visually. Type / on an empty line to insert blocks, media, math, and more.",
      data: { action: "Try typing / in the visual editor" },
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "html",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="document-preview"]',
      title: "Preview interactive HTML",
      content: "Use HTML for interactive explanations and run them directly in the preview.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "board",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="board-workspace"]',
      title: "Sketch ideas on a shared board",
      content: "Use the canvas for diagrams, freehand notes, and early research structure.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "collaboration",
      target: '[data-tour="collaboration"]',
      title: "Write together in real time",
      content: "Open the collaboration panel to start or join a shared workspace.",
      data: { action: "Select Collaboration" },
      buttons: ACTION_BUTTONS,
      placement: "bottom-end",
    },
    {
      id: "collaboration-panel",
      target: '[data-tour="collaboration-panel"]',
      title: "Share the whole research workspace",
      content: "Invite collaborators to edit files, figures, papers, and comments together in real time.",
      buttons: READING_BUTTONS,
      placement: "left",
    },
    {
      id: "overleaf",
      target: '[data-tour="overleaf"]',
      title: "Keep working with Overleaf collaborators",
      content: "Open the Overleaf panel to connect an existing project.",
      data: { action: "Select Overleaf" },
      buttons: ACTION_BUTTONS,
      placement: "bottom-end",
    },
    {
      id: "overleaf-panel",
      target: '[data-tour="overleaf-panel"]',
      title: "Move between Lattice and Overleaf",
      content: "Download an Overleaf project, work locally, then sync files, comments, and live edits.",
      buttons: READING_BUTTONS,
      placement: "left",
    },
    {
      id: "git",
      target: '[data-tour="git"]',
      title: "Manage changes with Git",
      content: "Open the Git workspace to review your project history.",
      data: { action: "Select Git" },
      buttons: ACTION_BUTTONS,
      placement: "bottom-end",
    },
    {
      id: "git-panel",
      target: '[data-tour="git-panel"]',
      title: "Keep every change reviewable",
      content: "Review changes, create commits, and work with pull requests without leaving Lattice.",
      buttons: READING_BUTTONS,
      placement: "left",
    },
    {
      id: "open-papers",
      target: '[data-tour="papers-tab"]',
      title: "Keep sources with the project",
      content: "Manage papers and bibliography records in one place.",
      data: { action: "Select Papers" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
    },
    {
      id: "papers",
      target: '[data-tour="project-panel"]',
      title: "Turn citations into a paper library",
      content: "The bibliography is already organized here. Papers with an arXiv ID can be downloaded in one click.",
      buttons: READING_BUTTONS,
      placement: "right-start",
    },
    {
      id: "import-vit",
      target: '[data-tour="tutorial-vit-paper"]',
      title: "Add the Vision Transformer paper",
      content: "Download this cited paper. Lattice keeps the full paper, figures, metadata, and bibliography together.",
      data: { action: "Select “An Image is Worth 16×16 Words”" },
      buttons: ACTION_BUTTONS,
      placement: "right-start",
      disableFocusTrap: true,
    },
    {
      id: "paper-blog",
      target: '[data-tour="paper-fulltext"]',
      title: "Start with the generated overview",
      content: "The Blog view gives you a visual, readable guide to the paper before you read the source.",
      data: { action: "Select Paper to read the full text" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
      hideOverlay: true,
    },
    {
      id: "paper-full-text",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="paper-reading-view"]',
      title: "Read the complete paper in the same workspace",
      content: "The Paper view preserves the full text, equations, sections, and figures as structured Markdown.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "open-agent",
      target: '[data-tour="agent-tab"]',
      title: "Choose your writing Agent",
      content: "Use Codex, Claude, or another configured provider.",
      data: { action: "Select Agent" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
    },
    {
      id: "agent",
      target: '[data-tour="agent-panel"]',
      title: "Work with the project as context",
      content: "Agents use project context; Skills and MCP add workflows and tools.",
      buttons: READING_BUTTONS,
      placement: "right-start",
    },
    ];
  }, []);

  const handleEvent = (event: EventData) => {
    if (event.status === STATUS.SKIPPED || event.action === ACTIONS.SKIP) {
      props.onSkip();
      return;
    }
    if (event.status === STATUS.FINISHED) {
      if (event.index === steps.length - 1) props.onComplete();
      return;
    }
    if (event.type !== EVENTS.STEP_AFTER) return;
    if (event.action === ACTIONS.PREV) {
      props.onStepIndexChange(Math.max(0, event.index - 1));
    } else if (event.action === ACTIONS.NEXT || event.action === ACTIONS.CLOSE) {
      const fileTransition = ({
        [TUTORIAL_STEPS.welcome]: { path: "main.tex", step: TUTORIAL_STEPS.latex },
        [TUTORIAL_STEPS.viewModes]: { path: "notes.md", step: TUTORIAL_STEPS.markdown },
        [TUTORIAL_STEPS.markdownVisual]: { path: "attention-demo.html", step: TUTORIAL_STEPS.html },
        [TUTORIAL_STEPS.html]: { path: "attention-map.tldr", step: TUTORIAL_STEPS.board },
        [TUTORIAL_STEPS.board]: { path: "main.tex", step: TUTORIAL_STEPS.collaboration },
      } as Record<number, { path: string; step: number }>)[event.index];
      if (fileTransition) {
        if (event.index === TUTORIAL_STEPS.markdownVisual) closeMarkdownSlashMenu();
        const file = projectTreeFile(fileTransition.path);
        const select = () => props.onSelectTutorialFile(fileTransition.path, fileTransition.step);
        if (file) animatePointerClick(file, select);
        else select();
        return;
      }
      if (event.index === TUTORIAL_STEPS.papers) {
        props.onStepIndexChange(TUTORIAL_STEPS.importVit);
        return;
      }
      if (event.index === TUTORIAL_STEPS.paperFullText) {
        props.onStepIndexChange(TUTORIAL_STEPS.openAgent);
        return;
      }
      if (event.index === steps.length - 1) {
        props.onComplete();
        return;
      }
      props.onStepIndexChange(Math.min(steps.length - 1, event.index + 1));
    }
  };

  return (
    <>
    {props.stepIndex === TUTORIAL_STEPS.paperBlog && (
      <svg
        ref={paperBlogSpotlightRef}
        className="lattice-tour-dual-spotlight"
        aria-hidden="true"
      >
        <defs>
          <mask id="lattice-tour-paper-blog-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect className="lattice-tour-dual-spotlight-mask-base" width="100%" height="100%" />
            <path ref={paperBlogMaskRef} className="lattice-tour-dual-spotlight-mask-holes" />
          </mask>
        </defs>
        <rect
          className="lattice-tour-dual-spotlight-mask"
          width="100%"
          height="100%"
          mask="url(#lattice-tour-paper-blog-mask)"
        />
        <path ref={paperBlogReadingRingRef} className="lattice-tour-dual-spotlight-ring" />
        <path ref={paperBlogSwitcherRingRef} className="lattice-tour-dual-spotlight-ring emphasized" />
      </svg>
    )}
    <Joyride
      run={props.active}
      continuous
      stepIndex={props.stepIndex}
      steps={steps}
      onEvent={handleEvent}
      tooltipComponent={LatticeTourTooltip}
      floatingOptions={{ hideArrow: true }}
      locale={{ back: "Back", last: "Finish", next: "Continue", skip: "Skip tour" }}
      options={{
        arrowColor: "var(--surface-panel-raised)",
        backgroundColor: "var(--surface-panel-raised)",
        dismissKeyAction: false,
        overlayClickAction: false,
        overlayColor: "rgb(8 10 14 / 0.48)",
        primaryColor: "var(--control-active)",
        showProgress: true,
        skipBeacon: true,
        spotlightPadding: 8,
        spotlightRadius: 10,
        targetWaitTimeout: 4_000,
        textColor: "var(--text-primary)",
        width: 350,
        zIndex: 1500,
      }}
      styles={{ tooltip: { backgroundColor: "transparent", padding: 0 } }}
    />
    <div
      className={`lattice-tour-pointer${pointer.pressed ? " pressed" : ""}`}
      aria-hidden="true"
      data-visible={pointer.visible || undefined}
      style={{ left: pointer.x, top: pointer.y }}
    >
      <MousePointer2 size={25} strokeWidth={1.8} />
    </div>
    </>
  );
}
