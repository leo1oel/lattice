/**
 * The Overleaf collaboration drawer: comments, chat and tracked changes for a
 * linked Overleaf project; and margin review, the same comments and
 * suggestions beside their lines in the source.
 */
import { lazy, Suspense, useEffect, useSyncExternalStore, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { EditorView } from "@codemirror/view";
import { OVERLEAF_COMMENT_PREFIX, type useOverleafWorkspace } from "./use-overleaf-workspace";
import type { OpenProjectFile, ViewRestoreRequest } from "../app-types";
import { marginReviewMode, registerMarginReviewLayer, subscribeMarginReview } from "../overleaf/margin-review-mode";
import { collabPeopleHues } from "../overleaf/overleaf-collab-people";

const OverleafCollabDrawer = lazy(() =>
  import("../overleaf/overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);
const OverleafMarginReview = lazy(() =>
  import("../overleaf/overleaf-margin-review").then((module) => ({ default: module.OverleafMarginReview })),
);

/**
 * Margin review in the source editor of a linked Overleaf project: the open
 * file's unresolved threads and its live suggestions. The layer's code loads
 * only once the file has one of either and the window has not turned margin
 * review off (View → Margin review).
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
  const changes = overleafRealtime.docId && overleaf.overleafDocPaths.get(overleafRealtime.docId) === path ? overleafRealtime.changes : [];
  if (mode === "off" || (!comments.length && !changes.length)) return null;
  return (
    <Suspense fallback={null}>
      <OverleafMarginReview
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
