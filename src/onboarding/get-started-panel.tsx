/**
 * The Get started checklist: a dockable tool panel (beside Project, by
 * default) that walks a first paper in six steps (get-started-steps.ts).
 *
 * It replaces the old spotlight tour, and differs from it on purpose:
 * - nothing dims or blocks the window, and nothing listens for Escape: the
 *   writer works in the real workspace with the list beside it;
 * - progress is the writer's and lasts (get-started-progress.ts): a step
 *   ticks where it really happens, the list picks up where it was left, and
 *   closing the panel loses nothing;
 * - setup is a step, not a dialog that lands on top of the tour: installing
 *   LaTeX is the first step's action, the paper tools are offered where
 *   citing needs them, and the Agent step points at the Agent panel, which
 *   shows whether Claude Code or Codex is connected, with how to connect one
 *   folded beneath it.
 *
 * Loaded lazily with its stylesheet: only a window that shows it needs it.
 */
import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, ListChecks } from "lucide-react";
import { restartAgentRuntime } from "../agent/agent-environment";
import { toMessage } from "../app-utils";
import { showError, showWarning } from "../app/notify";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { CheckStatus } from "../project/check-status";
import { useSharedSetting } from "../settings/shared-setting";
import { useLatestRef } from "../hooks/use-latest-ref";
import { isCompileSetupMissing, missingPaperToolNames } from "../build/tex-setup";
import type { TexSetup } from "../app/use-tex-setup";
import {
  GET_STARTED_STEPS, getStartedProgress, markGetStartedStep, skipGetStartedStep, type GetStartedStepId,
} from "./get-started-progress";
import { GET_STARTED, type GetStartedStep, type ShowMeContext } from "./get-started-steps";
import "./get-started.css";

const CLAUDE_CODE_URL = "https://github.com/anthropics/claude-code";
const CODEX_URL = "https://github.com/openai/codex";
const DOWNLOAD_URL = "https://github.com/leo1oel/lattice/releases/latest";
/* eslint-disable lingui/no-unlocalized-strings -- product names, the same in every language */
const CLAUDE_CODE = "Claude Code";
const CODEX = "Codex";
/* eslint-enable lingui/no-unlocalized-strings */
/** How long "Show me" keeps its ring up when nothing else takes it down. */
const SHOW_ME_MS = 8000;

export type GetStartedPanelProps = ShowMeContext & {
  /** The toolchain check, and the setup the first steps install from. */
  texSetup: Pick<TexSetup, "doctorReport" | "doctorBusy" | "runDoctor" | "openWizard" | "openForMissingPaperTools">;
  openProviderSettings: () => void;
  newProject: () => void;
  openFolder: () => void | Promise<unknown>;
  openOverleaf?: () => void;
  onClose: () => void;
};

function openLink(url: string) {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- window.open's target and features
  if (import.meta.env.LATTICE_WEB_DEMO) window.open(url, "_blank", "noopener");
  else void openUrl(url).catch(() => undefined);
}

/** Shortcuts in a sentence (⌘S, ⌘⇧K) drawn as keys. */
function withKeys(text: string): ReactNode[] {
  return text.split(/([⌘⇧⌥⌃]+[A-Z0-9])/u).map((part, index) => (index % 2
    ? <kbd key={index} className="get-started-keys">{part}</kbd>
    : part));
}

function LinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <Button size="compact" variant="secondary" className="get-started-link" onClick={() => openLink(url)}>
      {children}<ArrowUpRight size={13} aria-hidden="true" />
    </Button>
  );
}

/**
 * "Show me": a ring round the place a step is about, with a word on it,
 * following it every frame. Nothing is dimmed and nothing takes the pointer;
 * it goes after a while, at the next click anywhere, or at Escape.
 */
function ShowMeRing({ target, hint, onDone }: { target: () => DOMRect | null; hint: string; onDone: () => void }) {
  // A rect equal to the last one keeps it, so following an unmoved place re-renders nothing.
  const [rect, follow] = useReducer((previous: DOMRect | null, next: DOMRect | null) => (
    previous && next && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height
      ? previous : next), null);
  // Read through refs: the ring stays up across the panel's renders.
  const targetRef = useLatestRef(target);
  const doneRef = useLatestRef(onDone);
  useEffect(() => {
    const finish = () => doneRef.current();
    let frame = 0;
    const track = () => {
      follow(targetRef.current());
      frame = requestAnimationFrame(track);
    };
    track();
    const timer = window.setTimeout(finish, SHOW_ME_MS);
    // The click that asked for the ring is still on its way: listen from the next frame.
    let armed = false;
    const arm = requestAnimationFrame(() => { armed = true; });
    const onPointer = () => { if (armed) finish(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) finish(); };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(arm);
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [doneRef, targetRef]);
  if (!rect) return null;
  return createPortal(
    <div className="get-started-show-me" aria-hidden="true">
      <div className="get-started-ring" style={{ transform: `translate(${rect.left}px, ${rect.top}px)`, width: rect.width, height: rect.height }} />
      <div className="get-started-hint" style={{ left: rect.left + rect.width / 2, top: rect.top + Math.min(rect.height * 0.3, 160) }}>
        {withKeys(hint)}
      </div>
    </div>,
    document.body,
  );
}

type PanelView = {
  /** The row opened by hand (null: the open one closed), and how many steps were done then: it stays so until another gets done. */
  open: { step: GetStartedStepId | null; seen: number } | null;
  /** The step whose place "Show me" is ringing. */
  showing: GetStartedStep | null;
  rechecking: boolean;
};

export default function GetStartedPanel(props: GetStartedPanelProps) {
  const { t, i18n } = useLingui();
  const [progress] = useSharedSetting(getStartedProgress);
  const [view, update] = useReducer((current: PanelView, patch: Partial<PanelView>) => ({ ...current, ...patch }), {
    open: null, showing: null, rechecking: false,
  });
  const { open, showing, rechecking } = view;
  const { controller, texSetup } = props;
  const { doctorReport: report, doctorBusy: checking, runDoctor } = texSetup;
  // Opened, the checklist comes to the front of its panel, without taking the
  // keyboard from the writer's document. Opened with the project it belongs
  // to (the demo's first load, a first launch), it may come before that
  // project's workspace does, when its drawer had nowhere to dock: it docks
  // once the workspace is there.
  useEffect(() => {
    const show = () => {
      const ws = controller.ws;
      if (!ws) return false;
      if (!ws.view("start")) controller.revealTool("start");
      ws.select?.("start");
      return true;
    };
    if (show()) return;
    const stop = controller.subscribeWorkspace(() => {
      if (show()) stop();
    });
    return stop;
  }, [controller]);

  const texReady = import.meta.env.LATTICE_WEB_DEMO || (report !== null && !isCompileSetupMissing(report));
  useEffect(() => {
    if (texReady) markGetStartedStep("latex");
  }, [texReady]);
  // A panel opened before launch's check ever ran asks for one, once; a build
  // that finds no TeX while it is shown asks again (use-tex-setup.ts).
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || report !== null || checking || import.meta.env.LATTICE_WEB_DEMO) return;
    askedRef.current = true;
    void runDoctor();
  }, [checking, report, runDoctor]);

  const done = new Set<GetStartedStepId>(progress.done);
  if (texReady) done.add("latex");
  else if (report && isCompileSetupMissing(report)) done.delete("latex");
  const skipped = new Set(progress.skipped);
  const current = GET_STARTED_STEPS.find((step) => !done.has(step) && !skipped.has(step)) ?? null;
  // A row opened by hand stays open until another step gets done.
  const expanded = open && open.seen === done.size ? open.step : current;
  const allDone = current === null;
  const paperToolsMissing = !import.meta.env.LATTICE_WEB_DEMO && missingPaperToolNames(report).length > 0;

  const showMe = (step: GetStartedStep) => {
    step.reveal?.(props);
    update({ showing: step });
  };
  const stopShowing = () => update({ showing: null });
  // A restart makes the agent look for the provider CLIs again, as it does
  // when it starts. It would stop every window's running turns, so while one
  // runs (src-tauri/src/app_restart.rs counts them) it waits.
  const recheck = async () => {
    update({ rechecking: true });
    try {
      const { agentTurns } = await invoke<{ agentTurns: number }>("restart_impact");
      if (agentTurns) {
        showWarning(t`Recheck restarts the agent, which would stop the turn running now. Recheck once it ends.`, t`Agent`);
        return;
      }
      await restartAgentRuntime();
      controller.showPanel("agent", { focus: false });
    } catch (reason) {
      showError(toMessage(reason));
    } finally {
      update({ rechecking: false });
    }
  };

  const valueOf = (id: GetStartedStepId): ReactNode => {
    if (id === "latex") {
      if (import.meta.env.LATTICE_WEB_DEMO) return t`Not needed here`;
      if (texReady) return t`Ready`;
      if (checking) return t`Checking…`;
      return report ? t`Not installed` : null;
    }
    if (done.has(id)) return t`Done`;
    if (skipped.has(id)) return t`Skipped`;
    return null;
  };

  const actionsOf = (step: GetStartedStep): ReactNode => {
    const skip = !done.has(step.id) && !skipped.has(step.id) && step.id !== "latex"
      ? <Button size="compact" variant="ghost" onClick={() => skipGetStartedStep(step.id)}>{t`Skip`}</Button>
      : null;
    const show = step.target
      ? <Button size="compact" variant="primary" onClick={() => showMe(step)}>{t`Show me`}</Button>
      : null;
    if (step.id === "latex") {
      // Without a report (a check that could not run), setup checks again itself.
      return texReady || checking ? null : <Button size="compact" variant="primary" onClick={() => void texSetup.openWizard()}>{t`Install LaTeX`}</Button>;
    }
    if (step.id === "agent" && import.meta.env.LATTICE_WEB_DEMO) {
      return <><LinkButton url={DOWNLOAD_URL}>{t`Download for Mac`}</LinkButton>{skip}</>;
    }
    if (step.id === "own") {
      if (import.meta.env.LATTICE_WEB_DEMO) return <LinkButton url={DOWNLOAD_URL}>{t`Download for Mac`}</LinkButton>;
      return (
        <>
          <Button size="compact" variant="primary" onClick={props.newProject}>{t`New project`}</Button>
          <Button size="compact" variant="secondary" onClick={() => void props.openFolder()}>{t`Open folder`}</Button>
          {props.openOverleaf && <Button size="compact" variant="secondary" onClick={props.openOverleaf}>{t`From Overleaf`}</Button>}
        </>
      );
    }
    return <>{show}{skip}</>;
  };

  const extraOf = (step: GetStartedStep): ReactNode => {
    if (step.id === "cite" && paperToolsMissing) {
      return (
        <div className="get-started-aside">
          <p>{t`Adding papers needs the paper tools, about 45 MB.`}</p>
          <Button size="compact" variant="secondary" onClick={() => void texSetup.openForMissingPaperTools("")}>{t`Install paper tools`}</Button>
        </div>
      );
    }
    if (step.id === "agent" && !import.meta.env.LATTICE_WEB_DEMO) {
      return (
        <details className="get-started-aside get-started-connect">
          <summary className="get-started-aside-title">{t`How to connect Claude Code or Codex`}</summary>
          <ol className="get-started-setup">
            <li>
              <span>{t`Install one of them.`}</span>
              <span className="get-started-links">
                <LinkButton url={CLAUDE_CODE_URL}>{CLAUDE_CODE}</LinkButton>
                <LinkButton url={CODEX_URL}>{CODEX}</LinkButton>
              </span>
            </li>
            <li><Trans>Sign in once: run <code>claude</code> or <code>codex</code> in Terminal.</Trans></li>
            <li><Trans>Lattice runs the one it finds on your PATH, the way Terminal does. Installed somewhere else? Set its path in Settings › Providers.</Trans></li>
          </ol>
          <div className="get-started-actions">
            <Button size="compact" variant="secondary" onClick={props.openProviderSettings}>{t`Provider settings`}</Button>
            <Button size="compact" variant="secondary" disabled={rechecking} onClick={() => void recheck()}>
              {rechecking ? t`Rechecking…` : t`Recheck`}
            </Button>
          </div>
        </details>
      );
    }
    return null;
  };

  return (
    <ResizableDrawer className="get-started-drawer" ariaLabel={t`Get started`} onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<ListChecks size={16} />} title={t`Get started`} onClose={props.onClose} />
      <div className="checklist-summary">
        <p className="checklist-verdict">{allDone ? t`You’re ready to write` : t`Your first paper in Lattice`}</p>
        <div className="checklist-progress">
          <span className="checklist-track" aria-hidden="true">
            {GET_STARTED_STEPS.map((step) => <span key={step} data-state={done.has(step) ? "ok" : "none"} />)}
          </span>
          <span className="checklist-progress-count">
            <span aria-hidden="true">{`${done.size}/${GET_STARTED_STEPS.length}`}</span>
            <span className="sr-only">{t`${done.size} of ${GET_STARTED_STEPS.length} steps done`}</span>
          </span>
        </div>
      </div>
      <ol className="get-started-steps">
        {GET_STARTED.map((step, index) => {
          const isDone = done.has(step.id);
          const isOpen = expanded === step.id;
          const value = valueOf(step.id);
          return (
            <li
              key={step.id}
              className={`get-started-step${isDone ? " ok" : ""}`}
              data-state={isDone ? "done" : skipped.has(step.id) ? "skipped" : step.id === current ? "current" : "todo"}
              data-step={step.id}
            >
              <button
                type="button"
                className="get-started-step-head"
                aria-expanded={isOpen}
                onClick={() => update({ open: { step: isOpen ? null : step.id, seen: done.size } })}
              >
                {isDone || skipped.has(step.id)
                  ? <CheckStatus ok={isDone ? true : null} />
                  : <i className="checklist-status get-started-number" aria-hidden="true">{index + 1}</i>}
                <strong>{i18n._(step.title)}</strong>
                {value ? <span>{value}</span> : <span />}
              </button>
              {isOpen && (
                <div className="get-started-step-body">
                  <p>{withKeys(i18n._(step.why))}</p>
                  {extraOf(step)}
                  <div className="get-started-actions">{actionsOf(step)}</div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {showing?.target && showing.hint && !done.has(showing.id) && (
        <ShowMeRing
          key={showing.id}
          target={() => showing.target?.(props) ?? null}
          hint={i18n._(showing.hint)}
          onDone={stopShowing}
        />
      )}
    </ResizableDrawer>
  );
}
