/**
 * Collaboration: the Lattice Shares dialog and the Overleaf collaboration
 * drawer (comments, chat and tracked changes for a linked Overleaf project).
 */
import { lazy, Suspense, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { SHARE_SOURCE, type useCollabV2Session } from "./use-collab-v2-session";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import { notifyWarning } from "../telemetry/app-notify";
import { isCollabEnabled } from "../collab/collab-feature-policy";
import type { EditorCollabSession } from "../collab/collab-session";
import type { CollabProjectRecordV2 } from "../collab/collab-rooms";
import type { CollabChat } from "../collab/use-collab-chat";
import type { OpenProjectFile, ViewRestoreRequest } from "../app-types";

const CollabDialog = lazy(() =>
  import("../collab/collab-dialog").then((module) => ({ default: module.CollabDialog })),
);
const OverleafCollabDrawer = lazy(() =>
  import("../overleaf/overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);

export type CollabV2Session = ReturnType<typeof useCollabV2Session>;

/** The Lattice Shares dialog. `joinOnly` is the Welcome screen's join form, which has no chat. */
export function AppCollabDialog({ collab, session, onJoin, onRejoin, onInstallTex, joinOnly = false, chat }: {
  collab: CollabV2Session;
  session: EditorCollabSession | null;
  onJoin: () => void;
  onRejoin: (record: CollabProjectRecordV2) => void;
  onInstallTex: () => void;
  joinOnly?: boolean;
  chat?: { chat: CollabChat; selfId: string; canWrite: boolean };
}) {
  if (!isCollabEnabled() || !collab.collabOpen) return null;
  return (
    <Suspense fallback={null}>
      <CollabDialog
        open
        mode={joinOnly ? "join" : collab.collabMode}
        role={collab.collabRole}
        joinOnly={joinOnly}
        {...chat && {
          chatMessages: chat.chat.messages,
          chatSelfId: chat.selfId,
          chatUnread: chat.chat.unread,
          onChatSend: (body: string) => {
            // The server rejects every write frame from a read grant with a
            // 4403 close that permanently stops the doc's client — a
            // read-only guest's send must not reach the doc at all.
            if (session?.canWrite === false || !chat.canWrite) {
              notifyWarning(SHARE_SOURCE, "Read-only guests cannot send chat messages");
              return;
            }
            chat.chat.send(body);
          },
          onChatOpen: chat.chat.markRead,
        }}
        host={collab.collabHost}
        room={collab.collabRoom}
        displayName={collab.collabName}
        projectName={collab.collabProjectName}
        inviteText={collab.collabInvite}
        status={collab.collabStatus}
        statusDetail={collab.collabStatusDetail}
        peerCount={collab.collabPeers}
        peers={collab.collabPeerList}
        fileCount={collab.collabFileCount}
        connectedRoom={session?.room ?? null}
        onClose={() => collab.setCollabOpen(false)}
        onModeChange={collab.setCollabMode}
        onRoomChange={collab.setCollabRoom}
        onDisplayNameChange={collab.setCollabName}
        onProjectNameChange={collab.setCollabProjectName}
        onInviteChange={collab.setCollabInvite}
        onStartShare={collab.startCollabShare}
        onJoinShare={onJoin}
        recentProjectsV2={collab.recentProjectsV2}
        onRejoinProjectV2={onRejoin}
        onForgetProjectV2={collab.forgetRecentProjectV2}
        onRenameProjectV2={collab.renameRecentProjectV2}
        onCloseProjectV2={collab.closeRecentProjectV2}
        onDisconnect={collab.disconnectCollab}
        onLeaveShare={() => void collab.leaveHostShareSession()}
        onCopyInvite={collab.copyCollabInvite}
        onRemovePeer={collab.removeCollabPeer}
        onInstallTex={onInstallTex}
      />
    </Suspense>
  );
}

export type OverleafWorkspace = ReturnType<typeof useOverleafWorkspace>;

export function AppOverleafCollabDrawer({ overleaf, onClose, setViewRestore, ...props }: {
  overleaf: OverleafWorkspace;
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
    <Suspense fallback={null}>
      <OverleafCollabDrawer
        localComments={props.localComments}
        localCommentCount={props.localCommentCount}
        hasLocalComments={props.hasLocalComments}
        focusLocalComments={props.focusLocalComments}
        focusThreadId={props.focusThreadId}
        tab={overleaf.overleafCollabTab}
        onTab={overleaf.setOverleafCollabTab}
        projectName={overleafLink.projectName}
        onClose={onClose}
        threads={overleafComments.threads}
        anchors={overleafComments.anchors}
        activeDocId={overleafRealtime.docId}
        pathForDoc={(id) => overleaf.overleafDocPaths.get(id) ?? null}
        documentOpen={overleafRealtime.docId !== null}
        commentsLoading={overleafComments.loading}
        commentsError={overleafComments.error}
        onReply={overleafComments.reply}
        onResolve={overleafComments.setResolved}
        onDeleteThread={overleafComments.remove}
        onEditMessage={overleafComments.editMessage}
        onDeleteMessage={overleafComments.deleteMessage}
        // The comment may be on a file that is not open, so open it first and
        // place the caret after.
        onRevealComment={(path, position) => {
          void props.openProjectFile(path).then(() => revealAt(path, position));
        }}
        onReveal={(position) => {
          const path = props.activeFileRef.current;
          if (path) revealAt(path, position);
        }}
        messages={overleafChat.messages}
        chatLoading={overleafChat.loading}
        chatError={overleafChat.error}
        onSend={overleafChat.send}
        unreadChat={overleafChat.unread}
        changes={overleafRealtime.changes}
        source={props.source}
        changeAuthorName={overleafTrackChanges.authorName}
        canActOnChanges={overleafRealtime.canWrite}
        changesBusy={overleafTrackChanges.busy}
        changesError={overleafTrackChanges.error}
        onAcceptChanges={overleafTrackChanges.accept}
        onRejectChanges={overleafTrackChanges.reject}
      />
    </Suspense>
  );
}
