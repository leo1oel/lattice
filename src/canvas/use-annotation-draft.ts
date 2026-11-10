import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { showError } from "../app/notify";
import type { NoteProgress } from "../editor/comments/editor-comment-data";
import { useCommittedRef } from "../hooks/use-latest-ref";
import type { AnnotationDraft } from "./annotation-composer";

/** The note, and (weakly, for the reason `useSourceSession`'s view is) the view it was opened in. */
type DraftState = { draft: AnnotationDraft | null; view: WeakRef<EditorView> | null };
const NO_DRAFT: DraftState = { draft: null, view: null };

/**
 * The note being written on a source selection. A note Overleaf is still
 * taking stays open until it lands or fails: the request cannot be called
 * back, and a failure is told on the note, beside what was typed, so neither
 * another note nor the caret leaving the selection replaces it meanwhile.
 */
export function useAnnotationDraft() {
  // State, not a reducer, and every change that alters nothing returns
  // `current`: the caret's every move releases the note, and only useState
  // skips such a no-op without re-rendering the canvas (source-scroll bench).
  const [{ draft, view: draftView }, change] = useState(NO_DRAFT);
  const draftRef = useCommittedRef(draft);
  const countRef = useRef(0);
  const setDraft = useCallback((next: AnnotationDraft | null) => change((current) => (
    current.draft === next ? current : { ...current, draft: next }
  )), []);
  const amendDraft = useCallback((update: Partial<AnnotationDraft>) => change((current) => (
    current.draft ? { ...current, draft: { ...current.draft, ...update } } : current
  )), []);
  const openDraft = useCallback((inView: EditorView, next: Omit<AnnotationDraft, "id">) => {
    if (draftRef.current?.saving) return;
    const id = ++countRef.current;
    change(() => ({ draft: { ...next, id }, view: new WeakRef(inView) }));
  }, [draftRef]);
  /** The selection went: the note closes with it, unless it is being saved. */
  const releaseDraft = useCallback(() => change((current) => (!current.draft || current.draft.saving ? current : { ...current, draft: null })), []);
  /**
   * Where what saving note `id` reports goes: onto that note while it is
   * open, null closing it, else a failure into a toast, so it is never lost
   * unseen with the note gone.
   */
  const reportTo = useCallback((id: number) => (progress: NoteProgress) => {
    if (draftRef.current?.id !== id) {
      if (progress?.error) showError(progress.error);
      return;
    }
    change((current) => (current.draft?.id === id ? { ...current, draft: progress && { ...current.draft, ...progress } } : current));
    if (!progress) draftView?.deref()?.focus();
  }, [draftRef, draftView]);
  return { draft, setDraft, draftRef, draftView, amendDraft, openDraft, releaseDraft, reportTo };
}
