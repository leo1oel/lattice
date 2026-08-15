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

/**
 * Remounts to spend on re-resolving a step target before giving up on it.
 *
 * Joyride only self-heals a missing target when it owns the step index. This
 * tour controls `stepIndex`, so a miss leaves it parked: the overlay renders
 * (its early return is bypassed while `waiting`), the spotlight cutout does
 * not, and the card never reaches the `tooltip` lifecycle — a fully dimmed
 * window with nothing on it.
 */
const TARGET_RECOVERY_ATTEMPTS = 2;
/** Polls, 100ms apart, for the markdown step's card and add-block affordance. */
const MARKDOWN_REVEAL_ATTEMPTS = 40;

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
          <button className="lattice-tour-skip" type="button" {...skipProps}>Skip tutorial</button>
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
  const [recoveryToken, setRecoveryToken] = useState(0);
  const recoveryAttemptsRef = useRef(0);
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
    // Never let a running animation swallow the next one's action. The tour
    // advances inside `activate`, so dropping it leaves Joyride's lifecycle
    // past the tooltip with the step index unchanged: the card and spotlight
    // go, the overlay stays, and the window is dimmed with no way forward.
    // Pressing Continue while the demonstration pointer is mid-flight — easy
    // on the Markdown step, which starts an animation of its own — used to do
    // exactly that. Abandon the animation in progress, including whatever it
    // was about to click, and run the new action right away.
    if (pointerRunningRef.current) {
      clearPointerTimers();
      pointerRunningRef.current = false;
      setPointer((current) => ({ ...current, visible: false, pressed: false }));
      activate();
      return;
    }
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

  /**
   * Reset the per-step scratch state.
   *
   * The tour used to be remounted on every step, which cleared this for free.
   * It no longer is, so a pointer animation still marked as running when the
   * step advances would make `animatePointerClick` bail out for the rest of
   * the tour and silently strand every later auto-click. The pointer's own
   * visibility needs no reset here — its hide timer is already scheduled.
   */
  useEffect(() => {
    recoveryAttemptsRef.current = 0;
    pointerRunningRef.current = false;
  }, [props.stepIndex]);

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
      const retry = () => {
        attempts += 1;
        if (attempts < MARKDOWN_REVEAL_ATTEMPTS) {
          pointerTimersRef.current.push(window.setTimeout(revealAndClickAdd, 100));
        }
      };
      // The card on screen is Joyride's signal that it has finished measuring
      // this step. Opening the slash menu any earlier rewrites the block DOM
      // it is still measuring, and the step lands on a dimmed window with no
      // spotlight. The card is also this animation's origin point.
      if (!document.querySelector(".lattice-tour")) {
        retry();
        return;
      }
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
        // Guarded because the press lands 680ms after the pointer sets off,
        // by which time the reader may already have moved on.
        animatePointerClick(addButton, () => { if (!cancelled) addButton.click(); });
        return;
      }
      retry();
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
      title: "Welcome to Lattice",
      content: "We opened a real project for you — the “Attention Is All You Need” paper — so you can try each feature on real files as we go. Skip whenever you like.",
      buttons: ["skip", "primary"],
    },
    {
      id: "latex",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="split-workspace"]',
      title: "Your LaTeX and your PDF, side by side",
      content: "Type in main.tex on the left. Lattice saves, compiles, and refreshes the PDF on the right on its own — there is no build button to hunt for.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "project-files",
      target: '[data-tour="project-panel"]',
      title: "Everything for the paper lives in one folder",
      content: "LaTeX, notes, figures, boards, and the papers you cite. Click any file in the tree to open it here.",
      buttons: READING_BUTTONS,
      placement: "right-start",
    },
    {
      id: "view-modes",
      target: '[data-tour="document-view"]',
      title: "Three ways to look at a document",
      content: "Edit for the source, Split for both, Preview for the finished result. Switch at any time.",
      buttons: READING_BUTTONS,
      placement: "bottom",
      spotlightPadding: 5,
    },
    {
      id: "markdown",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="split-workspace"]',
      title: "Notes and drafts in Markdown",
      content: "Not every file has to be LaTeX. notes.md gets the same live preview — source on the left, formatted on the right.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "markdown-visual",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="markdown-visual-editor"]',
      title: "The preview is editable too",
      content: "Click into the formatted side and type — no Markdown syntax needed. Press / on an empty line to drop in headings, tables, math, or images.",
      data: { action: "Try typing / in the visual editor" },
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "html",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="document-preview"]',
      title: "Run interactive explanations",
      content: "HTML files render live right here — handy for demos and figures you want to poke at instead of only look at.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "board",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="board-workspace"]',
      title: "Think visually on a board",
      content: "An infinite canvas for diagrams, arrows, and freehand notes. This one maps how attention flows, and every shape on it is editable.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "spreadsheet",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="spreadsheet-workspace"]',
      title: "Analyze results in a live spreadsheet",
      content: "Edit cells and formulas directly. In shared projects, co-authors’ selections and pointers appear live.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "spreadsheet-tools",
      target: '[data-u-comp="ribbon-toolbar"]',
      title: "Formulas, Excel export, and Agent edits",
      content: "Use Formulas, export as .xlsx, or ask Agent to read and update ranges, formulas, and formatting.",
      buttons: READING_BUTTONS,
      placement: "bottom-start",
      spotlightPadding: 5,
    },
    {
      id: "workspace-actions",
      target: '[data-tour="workspace-actions"]',
      title: "Sharing and history live in this row",
      content: "Leave comments on a draft, share the project live with a co-author, sync a linked Overleaf project, commit to Git, or open the full version history — one button each, no terminal.",
      buttons: READING_BUTTONS,
      placement: "bottom-end",
    },
    {
      id: "open-papers",
      target: '[data-tour="papers-tab"]',
      title: "Your sources live in the project too",
      content: "Switch to Papers to see what this manuscript cites.",
      data: { action: "Click Papers" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
    },
    {
      id: "papers",
      target: '[data-tour="project-panel"]',
      title: "Your .bib file, as a readable library",
      content: "Every entry from the bibliography shows up here. Anything with an arXiv ID can be downloaded in full with one click.",
      buttons: READING_BUTTONS,
      placement: "right-start",
    },
    {
      id: "import-vit",
      target: '[data-tour="tutorial-vit-paper"]',
      title: "Let's download one of them",
      content: "Lattice fetches the full text, the figures, and the metadata, then keeps them attached to the citation.",
      data: { action: "Click “An Image is Worth 16×16 Words”" },
      buttons: ACTION_BUTTONS,
      placement: "right-start",
      disableFocusTrap: true,
    },
    {
      id: "paper-blog",
      target: '[data-tour="paper-fulltext"]',
      title: "Get the gist before you dive in",
      content: "Blog view is a generated, illustrated walkthrough of the paper — enough to tell whether it deserves a full read.",
      data: { action: "Click Paper to read the full text" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
      hideOverlay: true,
    },
    {
      id: "paper-full-text",
      target: '[data-tour="canvas-tour-card-anchor"]',
      spotlightTarget: '[data-tour="paper-reading-view"]',
      title: "Then read the real thing, right here",
      content: "Paper view keeps the complete text, sections, equations, and figures as structured Markdown — searchable, quotable, and next to your draft.",
      buttons: READING_BUTTONS,
      placement: "top-end",
      floatingOptions: { ...viewportFloatingOptions, hideArrow: true },
    },
    {
      id: "open-agent",
      target: '[data-tour="agent-tab"]',
      title: "Last stop: your writing agent",
      content: "Open the Agent tab. Codex, Claude, and other providers all plug in here.",
      data: { action: "Click Agent" },
      buttons: ACTION_BUTTONS,
      placement: "bottom",
      disableFocusTrap: true,
    },
    {
      id: "agent",
      target: '[data-tour="agent-panel"]',
      title: "An agent that has already read your project",
      content: "It sees your manuscript, notes, downloaded papers, and spreadsheets. Ask it to draft a section, check a claim against a source, or read and update a cell range in attention-results.lattice-sheet. Skills and MCP servers add more tools.",
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
    if (event.type === EVENTS.TARGET_NOT_FOUND) {
      // Remounting restarts Joyride's target polling, which is the only way
      // back out of the parked state while this tour owns the step index.
      if (recoveryAttemptsRef.current < TARGET_RECOVERY_ATTEMPTS) {
        recoveryAttemptsRef.current += 1;
        setRecoveryToken((token) => token + 1);
        return;
      }
      // Out of retries: move on rather than leave the window dimmed with
      // nothing on it and no way forward.
      if (props.stepIndex >= steps.length - 1) props.onComplete();
      else props.onStepIndexChange(props.stepIndex + 1);
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
        [TUTORIAL_STEPS.board]: { path: "attention-results.lattice-sheet", step: TUTORIAL_STEPS.spreadsheet },
        [TUTORIAL_STEPS.spreadsheetTools]: { path: "main.tex", step: TUTORIAL_STEPS.workspaceActions },
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
      key={`joyride:${recoveryToken}`}
      run={props.active}
      continuous
      stepIndex={props.stepIndex}
      steps={steps}
      onEvent={handleEvent}
      tooltipComponent={LatticeTourTooltip}
      floatingOptions={{ hideArrow: true }}
      locale={{ back: "Back", last: "Finish", next: "Continue", skip: "Skip tutorial" }}
      options={{
        arrowColor: "var(--surface-panel-raised)",
        backgroundColor: "var(--surface-panel-raised)",
        dismissKeyAction: false,
        overlayClickAction: false,
        overlayColor: "rgb(8 10 14 / 0.48)",
        primaryColor: "var(--control-active)",
        showProgress: true,
        skipBeacon: true,
        // The app shell and every tour target already fit the WebView. Letting
        // Joyride center a target's internal scroll parent also scrolls the
        // document in WebKit, shifting the entire fixed-height app offscreen.
        skipScroll: true,
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
