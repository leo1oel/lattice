/**
 * The Overleaf collaboration drawer: comments, chat and tracked changes for a
 * linked Overleaf project.
 */
import { lazy, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { OpenProjectFile, ViewRestoreRequest } from "../app-types";

const OverleafCollabDrawer = lazy(() =>
  import("../overleaf/overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);

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
