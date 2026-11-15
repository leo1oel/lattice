/**
 * A linked Overleaf project's comment threads in the Visual page, as the
 * Tauri app's source editor shows them (`app-overleaf-drawer.tsx`'s
 * `AppOverleafMarginReview`, `overleaf-editor-comments.ts`): each thread's
 * passage marked in its opener's colour, and margin review beside the text,
 * cards in the wide layout or pips in the markers one, as the window's margin
 * review mode says.
 *
 * The owner sends the file's threads where they are anchored, everyone's
 * hues as the Tauri app keys them, the window's mode and whether this account
 * may act (`tex:overleaf`); a card's asks go back as `tex:overleaf-*`. The
 * page lists the file as its own document: an anchor's document is its path.
 * Overleaf's tracked changes are not shown here yet (gpui/docs/not-yet.md).
 */
import { useEffect, useLayoutEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import type { EditorComment } from "../../../src/editor/comments/editor-comment-data";
import { OverleafMarginReview } from "../../../src/overleaf/overleaf-margin-review";
import { MARKERS_LAYOUT, measureMarginLayout, sameMarginLayout, type MarginLayout } from "../../../src/overleaf/margin-review-layout";
import {
  marginReviewMode, registerMarginReviewLayer, setMarginReviewMode, subscribeMarginReview,
} from "../../../src/overleaf/margin-review-mode";
import type { PeopleHues } from "../../../src/overleaf/overleaf-collab-people";
import { overleafThreadActions, overleafThreadOf, type OverleafReview } from "./margin-review-data";

/** Overleaf's tracked changes are the Visual page's next step; none are shown yet. */
const NO_CHANGES: never[] = [];
const noAuthor = () => "";
const noChange = () => {};

/** Margin review over the page's editor, laid out from its width before it paints. */
export function VisualMarginReview({ view, path, review, comments }: {
  view: EditorView;
  path: string;
  review: OverleafReview;
  /** `overleafEditorComments(review, path)`, which the page's marks take too. */
  comments: EditorComment[];
}) {
  // The window's mode is the owner's (the palette's "Margin review: …").
  useEffect(() => setMarginReviewMode(review.mode), [review.mode]);
  useEffect(() => registerMarginReviewLayer(), []);
  const mode = useSyncExternalStore(subscribeMarginReview, marginReviewMode);
  const hues: PeopleHues = useMemo(() => new Map(review.hues), [review.hues]);
  const margin = useMemo(() => {
    const threads = new Map(review.threads.map((thread) => [thread.id, thread]));
    return comments.flatMap((comment) => {
      const id = overleafThreadOf(comment.id);
      const thread = id === null ? undefined : threads.get(id);
      if (id === null || !thread || comment.resolved) return [];
      return [{
        thread, from: comment.from, to: comment.to, color: comment.authorColor?.color ?? "var(--text-secondary)",
        anchor: { threadId: id, docId: path, position: comment.from, quote: comment.quote },
      }];
    });
  }, [comments, path, review.threads]);
  const reserved = mode !== "off" && margin.length > 0;
  const wantWide = mode === "auto";
  // The layer reports a change of geometry back; an equal layout keeps the state.
  const [layout, setLayout] = useReducer(
    (current: MarginLayout, next: MarginLayout) => sameMarginLayout(current, next) ? current : next,
    MARKERS_LAYOUT,
  );
  useLayoutEffect(() => {
    if (!reserved) return;
    // Read from the laid-out page, and rendered again before it paints.
    setLayout(measureMarginLayout(view, wantWide));
  }, [reserved, view, wantWide]);
  // The page's pane says how review shows; the text gives up its width only in wide mode.
  useLayoutEffect(() => {
    const pane = view.dom.closest<HTMLElement>(".source-editor");
    if (!pane || !reserved) return;
    pane.setAttribute("data-margin-review", layout.kind);
    return () => pane.removeAttribute("data-margin-review");
  }, [layout.kind, reserved, view]);
  if (!reserved) return null;
  return (
    <OverleafMarginReview
      {...overleafThreadActions}
      layout={layout}
      onLayout={setLayout}
      view={view}
      path={path}
      focusMode={false}
      comments={margin}
      changes={NO_CHANGES}
      authorName={noAuthor}
      canAct={review.canAct}
      changeBusy={null}
      onAccept={noChange}
      onReject={noChange}
      hues={hues}
    />
  );
}
