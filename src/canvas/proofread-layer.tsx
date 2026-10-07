import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { PROOFREAD_MAX_LENGTH, ProofreadFailure, proofreadWithAgent } from "../agent/agent-proofread";
import { proofreadAnchor, setProofreadAnchorEffect } from "../editor/proofread-anchor";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { ProofreadBridge } from "./proofread-bridge";
import { ProofreadCard, type ProofreadCardState } from "./proofread-card";

/** One open proofread: the text it was asked about and the element its card renders into. */
type ProofreadSession = {
  path: string;
  original: string;
  host: HTMLElement;
  state: ProofreadCardState;
};

type ProofreadLayerProps = {
  bridge: ProofreadBridge;
  projectRoot: string;
  activeFile: string;
  /** Changes whenever the editor is rebuilt, which drops the card's widget. */
  editorKey: string;
  editable: boolean;
  viewRef: RefObject<EditorView | null>;
};

/**
 * Proofreading the source editor's selection through the embedded agent.
 *
 * Mounted with the canvas but memoized, and only a shell until the first
 * request: the canvas renders often during startup, and the session's state
 * and callbacks would run on each of those renders for a feature most
 * sessions never open.
 */
export const ProofreadLayer = memo(function ProofreadLayer(props: ProofreadLayerProps) {
  const [active, setActive] = useState(false);
  const pendingRef = useRef<EditorView | null>(null);
  const { bridge, editable, projectRoot } = props;
  useLayoutEffect(() => {
    if (active) return;
    return bridge.connect({
      request: (view) => {
        if (!editable || !projectRoot || view.state.selection.main.empty) return false;
        pendingRef.current = view;
        setActive(true);
        return true;
      },
      accept: () => false,
      dismiss: () => false,
    });
  }, [active, bridge, editable, projectRoot]);
  return active ? <ProofreadSession {...props} pendingRef={pendingRef} /> : null;
});

/**
 * The card opens under the selection while the agent works, shows its
 * suggestion as a diff, and accepting replaces the span it was asked about in
 * one undoable edit. One proofread at a time; a new one replaces it.
 */
function ProofreadSession(options: ProofreadLayerProps & { pendingRef: RefObject<EditorView | null> }) {
  const { t } = useLingui();
  const { bridge, pendingRef, viewRef } = options;
  const [session, setSession] = useState<ProofreadSession | null>(null);
  const sessionRef = useLatestRef(session);
  const optionsRef = useLatestRef(options);
  const runRef = useRef<{ controller: AbortController; resize: ResizeObserver } | null>(null);

  const failureMessage = useCallback((error: unknown) => {
    if (error instanceof ProofreadFailure && error.kind === "unavailable") {
      return t`This version of the agent runtime cannot proofread yet. Update Lattice to use proofreading.`;
    }
    if (error instanceof ProofreadFailure && error.kind === "unreadable") {
      return t`The agent's reply did not contain a proofread version of the selection.`;
    }
    const detail = error instanceof ProofreadFailure ? error.detail : String(error);
    return detail ? t`The agent could not proofread the selection: ${detail}` : t`The agent could not proofread the selection.`;
  }, [t]);

  /** Ask the agent about `original`, reporting into the session that owns `host`. */
  const run = useCallback((path: string, original: string, host: HTMLElement) => {
    runRef.current?.controller.abort();
    const controller = new AbortController();
    // CodeMirror measures block widgets when it lays out, not when their
    // content grows: re-measure as the card goes from loading to a diff.
    const resize = runRef.current?.resize ?? new ResizeObserver(() => viewRef.current?.requestMeasure());
    resize.disconnect();
    resize.observe(host);
    runRef.current = { controller, resize };
    setSession({ path, original, host, state: { status: "loading" } });
    const settle = (state: ProofreadCardState) => {
      if (runRef.current?.controller !== controller) return;
      setSession((current) => current?.host === host ? { ...current, state } : current);
    };
    if (original.length > PROOFREAD_MAX_LENGTH) {
      const limit = PROOFREAD_MAX_LENGTH.toLocaleString();
      settle({ status: "error", message: t`Select at most ${limit} characters to proofread.`, retryable: false });
      return;
    }
    const { projectRoot } = optionsRef.current;
    proofreadWithAgent({ projectRoot, path, text: original, signal: controller.signal }).then(
      (proofread) => settle({ status: "ready", proofread }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        // Asking again cannot help a runtime that has no text tasks.
        const retryable = !(error instanceof ProofreadFailure && error.kind === "unavailable");
        settle({ status: "error", message: failureMessage(error), retryable });
      },
    );
  }, [failureMessage, optionsRef, t, viewRef]);

  const close = useCallback(() => {
    const active = runRef.current;
    active?.controller.abort();
    active?.resize.disconnect();
    runRef.current = null;
    const view = viewRef.current;
    if (view && proofreadAnchor(view.state)) view.dispatch({ effects: setProofreadAnchorEffect.of(null) });
    setSession(null);
  }, [viewRef]);

  /** Proofread `view`'s selection; false when there is nothing to proofread. */
  const start = useCallback((view: EditorView) => {
    const { activeFile, editable, projectRoot } = optionsRef.current;
    const range = view.state.selection.main;
    const original = view.state.sliceDoc(range.from, range.to);
    if (!editable || !projectRoot || !original.trim()) return false;
    const host = document.createElement("div");
    host.className = "proofread-card-host";
    // Collapse the selection so the toolbar steps aside; the span stays marked.
    view.dispatch({
      effects: setProofreadAnchorEffect.of({ from: range.from, to: range.to, host }),
      selection: { anchor: range.to },
    });
    run(activeFile, original, host);
    return true;
  }, [optionsRef, run]);

  const accept = useCallback(() => {
    const view = viewRef.current;
    const current = sessionRef.current;
    if (!view || current?.state.status !== "ready" || !optionsRef.current.editable) return false;
    const anchor = proofreadAnchor(view.state);
    if (anchor?.host !== current.host) return false;
    // An edit inside the span while the agent worked would be overwritten.
    if (view.state.sliceDoc(anchor.from, anchor.to) !== current.original) {
      setSession({
        ...current,
        state: { status: "error", message: t`The selected text changed while it was being proofread. Proofread it again to review the current text.`, retryable: true },
      });
      return true;
    }
    const { proofread } = current.state;
    view.dispatch({
      changes: { from: anchor.from, to: anchor.to, insert: proofread },
      selection: { anchor: anchor.from, head: anchor.from + proofread.length },
      effects: setProofreadAnchorEffect.of(null),
      // Its own undo step, never merged with typing on either side.
      annotations: isolateHistory.of("full"),
      userEvent: "input.proofread",
      scrollIntoView: true,
    });
    close();
    view.focus();
    return true;
  }, [close, optionsRef, sessionRef, t, viewRef]);

  const retry = useCallback(() => {
    const view = viewRef.current;
    const current = sessionRef.current;
    const anchor = view && proofreadAnchor(view.state);
    if (!view || !current || anchor?.host !== current.host) return;
    run(current.path, view.state.sliceDoc(anchor.from, anchor.to), current.host);
  }, [run, sessionRef, viewRef]);

  const dismiss = useCallback(() => {
    close();
    viewRef.current?.focus();
    return true;
  }, [close, viewRef]);

  // A rebuilt editor (another file, a reload) has lost the card's widget.
  useEffect(() => close, [close, options.activeFile, options.editorKey, options.projectRoot]);

  useLayoutEffect(() => bridge.connect({ request: start, accept, dismiss }), [accept, bridge, dismiss, start]);
  // The request that mounted this session.
  useLayoutEffect(() => {
    const view = pendingRef.current;
    pendingRef.current = null;
    if (view) start(view);
  }, [pendingRef, start]);

  return session && session.path === options.activeFile ? createPortal(
    <ProofreadCard
      path={session.path}
      original={session.original}
      state={session.state}
      editable={options.editable}
      onAccept={accept}
      onDismiss={dismiss}
      onRetry={retry}
    />,
    session.host,
  ) : null;
}
