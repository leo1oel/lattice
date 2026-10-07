import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { PROOFREAD_MAX_LENGTH, ProofreadFailure, proofreadWithAgent, type ProofreadMode } from "../agent/agent-proofread";
import {
  applyProofreadEdits,
  chosenEdits,
  proofreadContext,
  protectedChange,
  reviewProofread,
  type ProofreadContext,
} from "../agent/proofread-edits";
import { proofreadAnchor, setProofreadAnchorEffect } from "../editor/proofread-anchor";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { ProofreadBridge } from "./proofread-bridge";
import { ProofreadCard, type ProofreadCardState } from "./proofread-card";

/**
 * One open proofread: the text it was asked about with the source around it
 * that its LaTeX check reads, the strength asked for, and the element its
 * card renders into.
 */
type ProofreadSession = {
  path: string;
  original: string;
  context: ProofreadContext;
  mode: ProofreadMode;
  host: HTMLElement;
  state: ProofreadCardState;
};

/** The selection `view`'s open proofread covers now, with its LaTeX context. */
function anchoredText(view: EditorView, from: number, to: number): { original: string; context: ProofreadContext } {
  const original = view.state.sliceDoc(from, to);
  // Past the limit the card refuses before asking, so it needs no context.
  if (original.length > PROOFREAD_MAX_LENGTH) return { original, context: { before: "", after: "" } };
  return { original, context: proofreadContext(view.state.doc.toString(), from, to) };
}

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
  const pendingRef = useRef<PendingRequest | null>(null);
  const { bridge, editable, projectRoot } = props;
  useLayoutEffect(() => {
    if (active) return;
    return bridge.connect({
      request: (view, mode = "proofread") => {
        if (!editable || !projectRoot || view.state.selection.main.empty) return false;
        pendingRef.current = { view, mode };
        setActive(true);
        return true;
      },
      accept: () => false,
      dismiss: () => false,
    });
  }, [active, bridge, editable, projectRoot]);
  return active ? <ProofreadSession {...props} pendingRef={pendingRef} /> : null;
});

/** The request that mounted the session, before its first render. */
type PendingRequest = { view: EditorView; mode: ProofreadMode };

/**
 * The card opens under the selection while the agent works and lists its
 * suggestion as separate edits. Lattice holds back any edit that would change
 * protected LaTeX; accepting applies the edits the writer kept to the span
 * it was asked about, in one undoable transaction. One proofread at a time; a
 * new one replaces it.
 */
function ProofreadSession(options: ProofreadLayerProps & { pendingRef: RefObject<PendingRequest | null> }) {
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
  const run = useCallback((request: Omit<ProofreadSession, "state">) => {
    const { context, host, mode, original, path } = request;
    runRef.current?.controller.abort();
    const controller = new AbortController();
    // CodeMirror measures block widgets when it lays out, not when their
    // content grows: re-measure as the card goes from loading to a diff.
    const resize = runRef.current?.resize ?? new ResizeObserver(() => viewRef.current?.requestMeasure());
    resize.disconnect();
    resize.observe(host);
    runRef.current = { controller, resize };
    setSession({ ...request, state: { status: "loading" } });
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
    proofreadWithAgent({ projectRoot, path, text: original, mode, signal: controller.signal }).then(
      ({ text, model }) => settle({ status: "ready", review: reviewProofread(original, text, context), rejected: new Set(), model }),
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

  /** Proofread or polish `view`'s selection; false when there is nothing to proofread. */
  const start = useCallback((view: EditorView, mode: ProofreadMode = "proofread") => {
    const { activeFile, editable, projectRoot } = optionsRef.current;
    const range = view.state.selection.main;
    const { original, context } = anchoredText(view, range.from, range.to);
    if (!editable || !projectRoot || !original.trim()) return false;
    const host = document.createElement("div");
    host.className = "proofread-card-host";
    // Collapse the selection so the toolbar steps aside; the span stays marked.
    view.dispatch({
      effects: setProofreadAnchorEffect.of({ from: range.from, to: range.to, host }),
      selection: { anchor: range.to },
    });
    run({ path: activeFile, original, context, mode, host });
    return true;
  }, [optionsRef, run]);

  const dismiss = useCallback(() => {
    close();
    viewRef.current?.focus();
    return true;
  }, [close, viewRef]);

  /** Apply the edits the writer kept (every offered one with `all`); ⌘↵ applies the kept ones. */
  const apply = useCallback((all: boolean) => {
    const view = viewRef.current;
    const current = sessionRef.current;
    if (!view || current?.state.status !== "ready" || !optionsRef.current.editable) return false;
    const anchor = proofreadAnchor(view.state);
    if (anchor?.host !== current.host) return false;
    const fail = (message: string) => {
      setSession({ ...current, state: { status: "error", message, retryable: true } });
      return true;
    };
    // An edit inside the span while the agent worked would be overwritten.
    if (view.state.sliceDoc(anchor.from, anchor.to) !== current.original) {
      return fail(t`The selected text changed while it was being proofread. Proofread it again to review the current text.`);
    }
    const edits = all ? current.state.review.edits : chosenEdits(current.state.review, current.state.rejected);
    if (!edits.length) return dismiss();
    const revised = applyProofreadEdits(current.original, edits);
    // Each edit passed on its own; two together could still form LaTeX
    // neither did (a backslash and a word meeting, say).
    if (protectedChange(current.original, revised, current.context)) {
      return fail(t`Together, the chosen edits would change LaTeX. Accept fewer edits, or proofread again.`);
    }
    view.dispatch({
      changes: edits.map((edit) => ({ from: anchor.from + edit.from, to: anchor.from + edit.to, insert: edit.insert })),
      selection: { anchor: anchor.from, head: anchor.from + revised.length },
      effects: setProofreadAnchorEffect.of(null),
      // Its own undo step, never merged with typing on either side.
      annotations: isolateHistory.of("full"),
      userEvent: "input.proofread",
      scrollIntoView: true,
    });
    close();
    view.focus();
    return true;
  }, [close, dismiss, optionsRef, sessionRef, t, viewRef]);

  const accept = useCallback(() => apply(false), [apply]);
  const acceptAll = useCallback(() => apply(true), [apply]);

  /** Ask again about the span as it reads now, in `mode` (the session's own by default). */
  const retry = useCallback((mode?: ProofreadMode) => {
    const view = viewRef.current;
    const current = sessionRef.current;
    const anchor = view && proofreadAnchor(view.state);
    if (!view || !current || anchor?.host !== current.host) return;
    run({ ...current, ...anchoredText(view, anchor.from, anchor.to), mode: mode ?? current.mode });
  }, [run, sessionRef, viewRef]);

  const choose = useCallback((id: number, accepted: boolean) => {
    setSession((current) => {
      if (current?.state.status !== "ready") return current;
      const rejected = new Set(current.state.rejected);
      if (accepted) rejected.delete(id);
      else rejected.add(id);
      return { ...current, state: { ...current.state, rejected } };
    });
  }, []);

  // A rebuilt editor (another file, a reload) has lost the card's widget.
  useEffect(() => close, [close, options.activeFile, options.editorKey, options.projectRoot]);

  useLayoutEffect(() => bridge.connect({ request: start, accept, dismiss }), [accept, bridge, dismiss, start]);
  // The request that mounted this session.
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) start(pending.view, pending.mode);
  }, [pendingRef, start]);

  return session && session.path === options.activeFile ? createPortal(
    <ProofreadCard
      path={session.path}
      original={session.original}
      mode={session.mode}
      state={session.state}
      editable={options.editable}
      onAccept={accept}
      onAcceptAll={acceptAll}
      onDismiss={dismiss}
      onRetry={() => retry()}
      onMode={retry}
      onChoose={choose}
    />,
    session.host,
  ) : null;
}
