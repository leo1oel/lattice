import { ArrowLeft, ArrowRight, MousePointer2, Sparkles } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS, EVENTS, Joyride, STATUS, type EventData, type Step, type TooltipRenderProps } from "react-joyride";
import { TUTORIAL_STEPS } from "./onboarding-steps";

const ACTION_BUTTONS: Step["buttons"] = ["back", "skip"];
const READING_BUTTONS: Step["buttons"] = ["back", "skip", "primary"];
const MARKDOWN_EDITOR = '[role="textbox"][aria-label="Markdown document editor"]';

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

/** Steps whose Continue opens a sample file, clicked in the project tree when it is visible. */
const FILE_TRANSITIONS: Partial<Record<number, { path: string; step: number }>> = {
  [TUTORIAL_STEPS.welcome]: { path: "main.tex", step: TUTORIAL_STEPS.latex },
  [TUTORIAL_STEPS.presentationCreate]: { path: "slides/understanding-attention/index.tsx", step: TUTORIAL_STEPS.presentation },
  [TUTORIAL_STEPS.presentation]: { path: "main.tex", step: TUTORIAL_STEPS.viewModes },
  [TUTORIAL_STEPS.viewModes]: { path: "notes.md", step: TUTORIAL_STEPS.markdown },
  [TUTORIAL_STEPS.markdownVisual]: { path: "attention-demo.html", step: TUTORIAL_STEPS.html },
  [TUTORIAL_STEPS.html]: { path: "attention-map.tldr", step: TUTORIAL_STEPS.board },
  [TUTORIAL_STEPS.board]: { path: "attention-results.lattice-sheet", step: TUTORIAL_STEPS.spreadsheet },
  [TUTORIAL_STEPS.spreadsheetTools]: { path: "main.tex", step: TUTORIAL_STEPS.workspaceActions },
};

type TutorialPointerState = { visible: boolean; pressed: boolean; x: number; y: number };
type DualSpotlight = { viewBox: string; holes: string; reading: string; switcher: string };

function roundedSpotlightPath(rect: DOMRect, padding = 8, radius = 10): string {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  const right = Math.min(window.innerWidth, rect.right + padding);
  const bottom = Math.min(window.innerHeight, rect.bottom + padding);
  const corner = Math.min(radius, (right - left) / 2, (bottom - top) / 2);
  /* eslint-disable lingui/no-unlocalized-strings -- SVG path command syntax. */
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
/* eslint-enable lingui/no-unlocalized-strings */

/** The paper-blog step spotlights the reading view and the Blog/Paper switcher together. */
function paperBlogTargets() {
  const readingView = document.querySelector<HTMLElement>('[data-tour="paper-reading-view"]');
  const paperTarget = document.querySelector<HTMLElement>('[data-tour="paper-fulltext"]');
  const switchTarget = paperTarget?.closest<HTMLElement>(".paper-content-switcher") ?? paperTarget;
  return { readingView, paperTarget, switchTarget };
}

function projectTreeFile(path: string): HTMLElement | null {
  const root = document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot;
  return Array.from(root?.querySelectorAll<HTMLElement>("button[data-item-path]") ?? [])
    .find((item) => item.dataset.itemPath === path) ?? null;
}

/** The visible Markdown block nearest the middle of the visual editor. */
function markdownBlockForTour(): HTMLElement | null {
  const editor = document.querySelector<HTMLElement>(MARKDOWN_EDITOR);
  if (!editor) return null;
  const viewport = editor.closest<HTMLElement>('[data-tour="markdown-visual-editor"]')?.getBoundingClientRect()
    ?? editor.getBoundingClientRect();
  const center = viewport.top + viewport.height / 2;
  const distance = (block: HTMLElement) => {
    const rect = block.getBoundingClientRect();
    return Math.abs((rect.top + rect.bottom) / 2 - center);
  };
  return Array.from(editor.children).filter((child): child is HTMLElement => {
    const rect = child.getBoundingClientRect();
    return child instanceof HTMLElement
      && rect.width > 0
      && rect.height > 0
      && rect.bottom > viewport.top + 24
      && rect.top < viewport.bottom - 24;
  }).sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

function closeMarkdownSlashMenu() {
  if (!document.querySelector('[role="listbox"][aria-label="Slash commands"]')) return;
  document.querySelector<HTMLElement>(MARKDOWN_EDITOR)?.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  }));
}

function LatticeTourTooltip(props: TooltipRenderProps) {
  const { t } = useLingui();
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
        {canSkip && <button className="lattice-tour-skip" type="button" {...skipProps}>{t`Skip tutorial`}</button>}
      </header>
      <progress className="lattice-tour-progress" max={size} value={index + 1} aria-label={t`Tutorial progress: step ${index + 1} of ${size}`} />
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
              <ArrowLeft size={14} aria-hidden="true" /> {t`Back`}
            </button>
          ) : <span />}
          {canContinue && (
            <button className="lattice-tour-button primary" type="button" {...primaryProps}>
              {isLastStep ? t`Finish` : t`Continue`}
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
  const { t } = useLingui();
  const pointerTimersRef = useRef<number[]>([]);
  const pointerRunningRef = useRef(false);
  const [recoveryToken, setRecoveryToken] = useState(0);
  const recoveryAttemptsRef = useRef(0);
  const [pointer, setPointer] = useState<TutorialPointerState>({ visible: false, pressed: false, x: 0, y: 0 });
  const [blogSpotlight, setBlogSpotlight] = useState<DualSpotlight | null>(null);

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
    const interrupted = pointerRunningRef.current;
    clearPointerTimers();
    if (interrupted || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)) {
      pointerRunningRef.current = false;
      if (interrupted) setPointer((current) => ({ ...current, visible: false, pressed: false }));
      activate();
      return;
    }
    pointerRunningRef.current = true;
    const targetRect = target.getBoundingClientRect();
    const originRect = document.querySelector<HTMLElement>(".lattice-tour")?.getBoundingClientRect();
    setPointer({
      visible: true,
      pressed: false,
      x: originRect ? originRect.left + 24 : window.innerWidth / 2,
      y: originRect ? originRect.top + 24 : window.innerHeight / 2,
    });
    const at = (delay: number, frame: () => void) => pointerTimersRef.current.push(window.setTimeout(frame, delay));
    at(POINTER_TIMING.startMove, () => setPointer((current) => ({
      ...current,
      x: targetRect.left + targetRect.width / 2,
      y: targetRect.top + targetRect.height / 2,
    })));
    at(POINTER_TIMING.press, () => setPointer((current) => ({ ...current, pressed: true })));
    at(POINTER_TIMING.activate, () => {
      activate();
      setPointer((current) => ({ ...current, pressed: false }));
    });
    at(POINTER_TIMING.hide, () => {
      setPointer((current) => ({ ...current, visible: false }));
      pointerRunningRef.current = false;
    });
  }, [clearPointerTimers]);

  /**
   * Reset the per-step scratch state.
   *
   * The tour is not remounted per step, so a pointer animation still marked
   * as running when the step advances would make `animatePointerClick` bail
   * out for the rest of the tour and silently strand every later auto-click.
   * The pointer's own visibility needs no reset here — its hide timer is
   * already scheduled.
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
      if (!document.querySelector(".lattice-tour")) return retry();
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
      if (!addButton || !addRect || !blockRect || addRect.width <= 0 || addRect.height <= 0
        || Math.abs(addRect.top - blockRect.top) >= 72) return retry();
      // Guarded because the press lands 680ms after the pointer sets off,
      // by which time the reader may already have moved on.
      animatePointerClick(addButton, () => { if (!cancelled) addButton.click(); });
    };
    pointerTimersRef.current.push(window.setTimeout(revealAndClickAdd, POINTER_TIMING.markdownReady));
    return () => { cancelled = true; };
  }, [animatePointerClick, props.stepIndex]);

  useEffect(() => {
    if (props.stepIndex !== TUTORIAL_STEPS.paperBlog) return;
    let frame = 0;
    const updatePaperBlogSpotlight = () => {
      const { readingView, switchTarget } = paperBlogTargets();
      if (!readingView || !switchTarget) return;
      const reading = roundedSpotlightPath(readingView.getBoundingClientRect());
      const switcher = roundedSpotlightPath(switchTarget.getBoundingClientRect(), 6, 8);
      setBlogSpotlight({ viewBox: `0 0 ${window.innerWidth} ${window.innerHeight}`, holes: `${reading} ${switcher}`, reading, switcher });
    };
    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePaperBlogSpotlight);
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    const observer = new ResizeObserver(scheduleUpdate);
    const { readingView, paperTarget } = paperBlogTargets();
    for (const element of [readingView, paperTarget]) if (element) observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      observer.disconnect();
      setBlogSpotlight(null);
    };
  }, [props.stepIndex]);

  const steps = useMemo<Step[]>(() => {
    const step = (id: string, target: string, placement: Step["placement"], title: string, content: string, extra?: Partial<Step>): Step =>
      ({ id, target, placement, title, content, buttons: READING_BUTTONS, ...extra });
    // The reader performs these steps by clicking the highlighted control.
    const action = (id: string, target: string, placement: Step["placement"], title: string, content: string, instruction: string, extra?: Partial<Step>) =>
      step(id, target, placement, title, content, { data: { action: instruction }, buttons: ACTION_BUTTONS, disableFocusTrap: true, ...extra });
    // Whole-workspace steps pin the card to the canvas corner anchor and
    // spotlight the workspace instead, so the card must stay in the viewport.
    const canvas = (id: string, spotlightTarget: string, title: string, content: string, extra?: Partial<Step>) =>
      step(id, '[data-tour="canvas-tour-card-anchor"]', "top-end", title, content, {
        spotlightTarget,
        floatingOptions: {
          strategy: "fixed",
          flipOptions: false,
          shiftOptions: { boundary: document.documentElement, rootBoundary: "viewport", padding: 12 },
          hideArrow: true,
        },
        ...extra,
      });
    return [
      step("welcome", "body", "center",
        t`Welcome to Lattice`,
        t`We opened the “Attention Is All You Need” sample project so you can try each feature on real files. You can skip the tutorial at any time`,
        { buttons: ["skip", "primary"] }),
      canvas("latex", '[data-tour="split-workspace"]',
        t`Your LaTeX and your PDF, side by side`,
        t`Edit main.tex on the left. The PDF on the right updates automatically`),
      step("project-files", '[data-tour="project-panel"]', "right-start",
        t`Everything for the paper lives in one folder`,
        t`This folder contains the manuscript, notes, figures, boards, spreadsheets, and cited papers. Click a file to open it`),
      step("presentation-create", '[data-tour="new-document"]', "bottom-end",
        t`Create with the + menu`,
        t`Use + to create a presentation, spreadsheet, or board`,
        { spotlightPadding: 5 }),
      canvas("presentation", '[data-tour="open-slide-workspace"]',
        t`Edit an Open Slide presentation`,
        t`This is a real, editable Open Slide deck. Use the thumbnail rail to browse pages, Inspect or Design to edit, and Present to show it. Agent can also revise its React and TSX source`),
      step("view-modes", '[data-tour="document-view"]', "bottom",
        t`Three ways to look at a document`,
        t`Use Edit for the source, Split for both, and Preview for the finished result`,
        { spotlightPadding: 5 }),
      canvas("markdown", '[data-tour="split-workspace"]',
        t`Notes and drafts in Markdown`,
        t`Edit notes.md on the left and see the formatted result update live on the right`),
      canvas("markdown-visual", '[data-tour="markdown-visual-editor"]',
        t`The preview is editable too`,
        t`Type directly in the formatted view without Markdown syntax. On an empty line, press / to insert headings, tables, math, or images`,
        { data: { action: t`Try typing / in the visual editor` } }),
      canvas("html", '[data-tour="document-preview"]',
        t`Preview interactive HTML`,
        t`HTML files render live here, so you can build interactive demos and figures`),
      canvas("board", '[data-tour="board-workspace"]',
        t`Think visually on a board`,
        t`Use the infinite canvas for diagrams, arrows, and freehand notes. Every shape is editable`),
      canvas("spreadsheet", '[data-tour="spreadsheet-workspace"]',
        t`Analyze results in a live spreadsheet`,
        t`Edit cells and formulas directly`),
      step("spreadsheet-tools", '[data-u-comp="ribbon-toolbar"]', "bottom-start",
        t`Formulas and Excel export`,
        t`Use Formulas in the toolbar, or export the spreadsheet as an .xlsx file`,
        { spotlightPadding: 5 }),
      step("workspace-actions", '[data-tour="workspace-actions"]', "bottom-end",
        t`Overleaf and history`,
        t`Overleaf opens or syncs an Overleaf project. Git and History let you commit and review versions`),
      action("open-papers", '[data-tour="papers-tab"]', "bottom",
        t`Manage cited papers`,
        t`Open Papers to see the sources cited by this manuscript`,
        t`Click Papers`),
      step("papers", '[data-tour="project-panel"]', "right-start",
        t`Browse your bibliography`,
        t`Each .bib entry appears here. Entries with an arXiv ID can be downloaded in full`),
      action("import-vit", '[data-tour="tutorial-vit-paper"]', "right-start",
        t`Let's download one of them`,
        t`Lattice downloads the full text, figures, and metadata and keeps them with the citation`,
        t`Click “An Image is Worth 16×16 Words”`),
      action("paper-blog", '[data-tour="paper-fulltext"]', "bottom",
        t`Get the gist before you dive in`,
        t`Blog view gives you an illustrated overview before you read the full paper`,
        t`Click Paper to read the full text`,
        { hideOverlay: true }),
      canvas("paper-full-text", '[data-tour="paper-reading-view"]',
        t`Read the full paper here`,
        t`Paper view shows the complete text, sections, equations, and figures as searchable Markdown beside your draft`),
      step("paper-actions", '[data-tour="paper-actions"]', "bottom-end",
        t`Open the PDF in Lattice or your browser`,
        t`Select PDF to read the original PDF in Lattice, or use the external-link button beside it to open the same PDF in your browser`,
        { spotlightPadding: 5 }),
      action("open-agent", '[data-tour="agent-tab"]', "bottom",
        t`Last stop: your writing agent`,
        t`Open the Agent tab to use Codex, Claude, or another provider`,
        t`Click Agent`),
      step("agent", '[data-tour="agent-panel"]', "right-start",
        t`An agent that works across your project`,
        t`Agent can read your manuscript, notes, papers, spreadsheets, and Open Slide presentations. Ask it to draft text, verify a claim against a source, analyze results, build slides, or revise files across the project`),
    ];
  }, [t]);

  const advanceFrom = (index: number) => {
    if (index >= steps.length - 1) props.onComplete();
    else props.onStepIndexChange(index + 1);
  };

  const handleEvent = (event: EventData) => {
    if (event.status === STATUS.SKIPPED || event.action === ACTIONS.SKIP) {
      props.onSkip();
    } else if (event.status === STATUS.FINISHED) {
      if (event.index === steps.length - 1) props.onComplete();
    } else if (event.type === EVENTS.TARGET_NOT_FOUND) {
      // Remounting restarts Joyride's target polling, which is the only way
      // back out of the parked state while this tour owns the step index.
      // Out of retries, move on rather than leave the window dimmed with
      // nothing on it and no way forward.
      if (recoveryAttemptsRef.current < TARGET_RECOVERY_ATTEMPTS) {
        recoveryAttemptsRef.current += 1;
        setRecoveryToken((token) => token + 1);
      } else {
        advanceFrom(props.stepIndex);
      }
    } else if (event.type === EVENTS.STEP_AFTER && event.action === ACTIONS.PREV) {
      props.onStepIndexChange(Math.max(0, event.index - 1));
    } else if (event.type === EVENTS.STEP_AFTER && (event.action === ACTIONS.NEXT || event.action === ACTIONS.CLOSE)) {
      const transition = FILE_TRANSITIONS[event.index];
      if (!transition) return advanceFrom(event.index);
      if (event.index === TUTORIAL_STEPS.markdownVisual) closeMarkdownSlashMenu();
      const file = projectTreeFile(transition.path);
      const select = () => props.onSelectTutorialFile(transition.path, transition.step);
      if (file) animatePointerClick(file, select);
      else select();
    }
  };

  return (
    <>
      {props.stepIndex === TUTORIAL_STEPS.paperBlog && (
        <svg className="lattice-tour-dual-spotlight" viewBox={blogSpotlight?.viewBox} aria-hidden="true">
          <defs>
            <mask id="lattice-tour-paper-blog-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
              <rect className="lattice-tour-dual-spotlight-mask-base" width="100%" height="100%" />
              <path className="lattice-tour-dual-spotlight-mask-holes" d={blogSpotlight?.holes} />
            </mask>
          </defs>
          <rect className="lattice-tour-dual-spotlight-mask" width="100%" height="100%" mask="url(#lattice-tour-paper-blog-mask)" />
          <path className="lattice-tour-dual-spotlight-ring" d={blogSpotlight?.reading} />
          <path className="lattice-tour-dual-spotlight-ring emphasized" d={blogSpotlight?.switcher} />
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
        locale={{ back: t`Back`, last: t`Finish`, next: t`Continue`, skip: t`Skip tutorial` }}
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
