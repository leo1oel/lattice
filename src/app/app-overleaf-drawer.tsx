/**
 * The Overleaf collaboration drawer: comments, chat and tracked changes for a
 * linked Overleaf project; and margin review, the same comments and
 * suggestions beside their lines in the source.
 */
import {
  lazy, Suspense, useEffect, useLayoutEffect, useState, useSyncExternalStore,
  type Dispatch, type ReactNode, type RefObject, type SetStateAction,
} from "react";
import type { EditorView } from "@codemirror/view";
import { OVERLEAF_COMMENT_PREFIX, type useOverleafWorkspace } from "./use-overleaf-workspace";
import type { OpenProjectFile, ViewRestoreRequest } from "../app-types";
import { lazyChunk } from "../lib/lazy-chunk";
import { hadSuggestions, loadMarginReviewLayer, rememberSuggestions, subscribeMarginReviewFiles } from "../overleaf/margin-review-files";
import { MARKERS_LAYOUT, measureMarginLayout, sameMarginLayout, type MarginLayout } from "../overleaf/margin-review-layout";
import { marginReviewMode, registerMarginReviewLayer, subscribeMarginReview } from "../overleaf/margin-review-mode";
import { collabPeopleHues } from "../overleaf/overleaf-collab-people";

const OverleafCollabDrawer = lazy(() =>
  import("../overleaf/overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);
const OverleafMarginReview = lazyChunk(loadMarginReviewLayer, (module) => module.OverleafMarginReview);

/**
 * Margin review in the source editor of a linked Overleaf project: the open
 * file's unresolved threads and its live suggestions. The layer's code loads
 * only once a file has one of either and the window has not turned margin
 * review off (View → Margin review).
 *
 * The pane's layout for review is decided here, before the editor's first
 * frame paints, from its width alone (margin-review-layout.ts); the layer
 * places the cards and reports a change of geometry back. A file whose
 * suggestions have not come yet (the live channel joins it after it opens)
 * keeps the margin it had when it was last open.
 */
export function AppOverleafMarginReview({ overleaf, view, path, focusMode }: {
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  view: EditorView;
  /** The file in the editor. */
  path: string;
  focusMode: boolean;
}) {
  const mode = useSyncExternalStore(subscribeMarginReview, marginReviewMode);
  // The View menu offers the switch while a linked project's source is on screen.
  useEffect(() => registerMarginReviewLayer(), []);
  const { overleafComments, overleafRealtime, overleafTrackChanges } = overleaf;
  const threads = new Map(overleafComments.threads.map((thread) => [thread.id, thread]));
  const comments = overleaf.overleafEditorComments.flatMap((comment) => {
    const id = comment.id.slice(OVERLEAF_COMMENT_PREFIX.length);
    const thread = threads.get(id);
    if (comment.path !== path || comment.resolved || !thread) return [];
    const docId = overleafComments.anchors.get(id)?.docId ?? overleafRealtime.docId ?? "";
    return [{
      thread, from: comment.from, to: comment.to, color: comment.authorColor?.color ?? "var(--text-secondary)",
      anchor: { threadId: id, docId, position: comment.from, quote: comment.quote },
    }];
  });
  // Suggestions come with the document the live channel carries, which is the open one.
  const live = overleafRealtime.docId !== null && overleaf.overleafDocPaths.get(overleafRealtime.docId) === path;
  const changes = live ? overleafRealtime.changes : [];
  const hasChanges = changes.length > 0;
  useEffect(() => {
    if (live) rememberSuggestions(path, hasChanges);
  }, [hasChanges, live, path]);
  const hadChanges = useSyncExternalStore(subscribeMarginReviewFiles, () => hadSuggestions(path));
  const reserved = mode !== "off" && (comments.length > 0 || hasChanges || (!live && hadChanges));
  const wantWide = mode === "auto" && !focusMode;
  const [layout, setLayout] = useState<MarginLayout>(MARKERS_LAYOUT);
  // Before the first frame: a state set in a layout effect renders again before paint.
  useLayoutEffect(() => {
    if (!reserved) return;
    const next = measureMarginLayout(view, wantWide);
    // eslint-disable-next-line react-hooks-js/set-state-in-effect -- read from the laid-out pane, and rendered again before it paints
    setLayout((current) => sameMarginLayout(current, next) ? current : next);
  }, [reserved, view, wantWide]);
  // The pane says how review shows, and the text gives up its width only in wide mode.
  useLayoutEffect(() => {
    const pane = view.dom.closest<HTMLElement>(".source-editor");
    if (!pane || !reserved) return;
    pane.setAttribute("data-margin-review", layout.kind);
    return () => pane.removeAttribute("data-margin-review");
  }, [layout.kind, reserved, view]);
  if (!reserved || (!comments.length && !changes.length)) return null;
  return (
    <Suspense fallback={null}>
      <OverleafMarginReview
        layout={layout}
        onLayout={setLayout}
        view={view}
        path={path}
        focusMode={focusMode}
        comments={comments}
        changes={changes}
        authorName={overleafTrackChanges.authorName}
        canAct={overleafRealtime.canWrite}
        changeBusy={overleafTrackChanges.busy}
        onAccept={(change) => void overleafTrackChanges.accept([change.id]).catch(() => undefined)}
        onReject={(change) => void overleafTrackChanges.reject([change]).catch(() => undefined)}
        hues={collabPeopleHues(overleaf.overleafPresence.peers, overleafRealtime.changes, overleafTrackChanges.authorName)}
        onReply={overleafComments.reply}
        onResolve={overleafComments.setResolved}
        onDelete={overleafComments.remove}
        onEditMessage={overleafComments.editMessage}
        onDeleteMessage={overleafComments.deleteMessage}
      />
    </Suspense>
  );
}

export function AppOverleafCollabDrawer({ overleaf, onClose, setViewRestore, activeFileRef, openProjectFile, source, ...localCommentProps }: {
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  onClose: () => void;
  localComments: ReactNode;
  localCommentCount: number;
  hasLocalComments: boolean;
  focusLocalComments: boolean;
  focusThreadId: string | null;
  activeFileRef: RefObject<string>;
  openProjectFile: OpenProjectFile;
  setViewRestore: Dispatch<SetStateAction<ViewRestoreRequest | null>>;
  source: string;
}) {
  const {
    overleafChat, overleafComments, overleafLink, overleafRealtime, overleafTrackChanges,
  } = overleaf;
  if (!overleaf.overleafCollabOpen || !overleafLink) return null;
  // A comment's anchor is a character offset rather than a line, which is what
  // `viewRestore` takes.
  const revealAt = (path: string, position: number) => {
    setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
    onClose();
  };
  return (
    <OverleafCollabDrawer
      {...localCommentProps}
      tab={overleaf.overleafCollabTab}
      onTab={overleaf.setOverleafCollabTab}
      onClose={onClose}
      comments={overleafComments}
      chat={overleafChat}
      trackChanges={overleafTrackChanges}
      realtime={overleafRealtime}
      pathForDoc={(id) => overleaf.overleafDocPaths.get(id) ?? null}
      peers={overleaf.overleafPresence.peers}
      source={source}
      // The comment may be on a file that is not open, so open it first and
      // place the caret after.
      onRevealComment={(path, position) => {
        void openProjectFile(path).then(() => revealAt(path, position));
      }}
      onReveal={(position) => {
        const path = activeFileRef.current;
        if (path) revealAt(path, position);
      }}
    />
  );
}
