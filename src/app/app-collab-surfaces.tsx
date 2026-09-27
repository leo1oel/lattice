/**
 * Collaboration: the Lattice Shares dialog and the Overleaf collaboration
 * drawer (comments, chat and tracked changes for a linked Overleaf project).
 *
 * `CollabDialog` is re-exported so the Welcome screen's join-only rendering in
 * App.tsx and the in-project one below share a single `lazy()` wrapper — two
 * wrappers over one specifier resolve to the same chunk, but they are two
 * component identities, so a dialog open across that boundary would remount.
 */
import { lazy, Suspense, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { SHARE_SOURCE } from "./use-collab-v2-session";
import { notifyWarning } from "../telemetry/app-notify";
import { isCollabEnabled } from "../collab/collab-feature-policy";
import type { CollabDialogMode } from "../collab/collab-dialog";
import type { CollabPeer, CollabStatus, EditorCollabSession } from "../collab/collab-session";
import type { CollabProjectRecordV2 } from "../collab/collab-rooms";
import type { CollabChat } from "../collab/use-collab-chat";
import type { OverleafChat } from "../overleaf/use-overleaf-chat";
import type { OverleafComments } from "../overleaf/use-overleaf-comments";
import type { OverleafRealtime } from "../overleaf/use-overleaf-realtime";
import type { OverleafTrackChanges } from "../overleaf/use-overleaf-track-changes";
import type { OverleafCollabTab } from "../overleaf/overleaf-collab";
import type { OpenProjectFile, OverleafLink, ViewRestoreRequest } from "../app-types";

export const CollabDialog = lazy(() =>
  import("../collab/collab-dialog").then((module) => ({ default: module.CollabDialog })),
);
const OverleafCollabDrawer = lazy(() =>
  import("../overleaf/overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);

export type AppCollabDialogProps = {
  closeRecentProjectV2: (record: CollabProjectRecordV2) => void;
  collabCanWrite: boolean;
  collabChat: CollabChat;
  collabFileCount: number;
  collabHost: string;
  collabInvite: string;
  collabMode: CollabDialogMode;
  collabName: string;
  collabOpen: boolean;
  collabPeerList: CollabPeer[];
  collabPeers: number;
  collabProjectName: string;
  collabRole: "host" | "guest";
  collabRoom: string;
  collabSession: EditorCollabSession | null;
  collabStatus: CollabStatus;
  collabStatusDetail: string | null;
  copyCollabInvite: () => Promise<boolean>;
  disconnectCollab: () => void;
  editorCommentAuthorId: string;
  forgetRecentProjectV2: (record: CollabProjectRecordV2) => void;
  joinCollabShare: () => void;
  leaveHostShareSession: () => Promise<void>;
  openTexSetupWizard: () => void;
  recentProjectsV2: CollabProjectRecordV2[];
  rejoinCollabProjectV2: (record: CollabProjectRecordV2) => void;
  removeCollabPeer: (peer: CollabPeer) => Promise<void>;
  renameRecentProjectV2: (record: CollabProjectRecordV2, name: string) => void;
  setCollabInvite: Dispatch<SetStateAction<string>>;
  setCollabMode: Dispatch<SetStateAction<CollabDialogMode>>;
  setCollabName: Dispatch<SetStateAction<string>>;
  setCollabOpen: Dispatch<SetStateAction<boolean>>;
  setCollabProjectName: Dispatch<SetStateAction<string>>;
  setCollabRoom: Dispatch<SetStateAction<string>>;
  startCollabShare: () => void;
};

export function AppCollabDialog(props: AppCollabDialogProps) {
  const { collabChat, collabSession } = props;
  if (!isCollabEnabled() || !props.collabOpen) return null;
  return (
    <Suspense fallback={null}>
      <CollabDialog
        open
        mode={props.collabMode}
        role={props.collabRole}
        joinOnly={false}
        chatMessages={collabChat.messages}
        chatSelfId={props.editorCommentAuthorId}
        chatUnread={collabChat.unread}
        onChatSend={(body) => {
          // The server rejects every write frame from a read grant with a
          // 4403 close that permanently stops the doc's client — a
          // read-only guest's send must not reach the doc at all.
          if (collabSession?.canWrite === false || !props.collabCanWrite) {
            notifyWarning(SHARE_SOURCE, "Read-only guests cannot send chat messages");
            return;
          }
          collabChat.send(body);
        }}
        onChatOpen={collabChat.markRead}
        host={props.collabHost}
        room={props.collabRoom}
        displayName={props.collabName}
        projectName={props.collabProjectName}
        inviteText={props.collabInvite}
        status={props.collabStatus}
        statusDetail={props.collabStatusDetail}
        peerCount={props.collabPeers}
        peers={props.collabPeerList}
        fileCount={props.collabFileCount}
        connectedRoom={collabSession?.room ?? null}
        onClose={() => props.setCollabOpen(false)}
        onModeChange={props.setCollabMode}
        onRoomChange={props.setCollabRoom}
        onDisplayNameChange={props.setCollabName}
        onProjectNameChange={props.setCollabProjectName}
        onInviteChange={props.setCollabInvite}
        onStartShare={props.startCollabShare}
        onJoinShare={props.joinCollabShare}
        recentProjectsV2={props.recentProjectsV2}
        onRejoinProjectV2={props.rejoinCollabProjectV2}
        onForgetProjectV2={props.forgetRecentProjectV2}
        onRenameProjectV2={props.renameRecentProjectV2}
        onCloseProjectV2={props.closeRecentProjectV2}
        onDisconnect={props.disconnectCollab}
        onLeaveShare={() => void props.leaveHostShareSession()}
        onCopyInvite={props.copyCollabInvite}
        onRemovePeer={props.removeCollabPeer}
        onInstallTex={props.openTexSetupWizard}
      />
    </Suspense>
  );
}

export type AppOverleafCollabDrawerProps = {
  localComments: ReactNode;
  localCommentCount: number;
  hasLocalComments: boolean;
  focusLocalComments: boolean;
  focusThreadId: string | null;
  activeFileRef: RefObject<string>;
  openProjectFile: OpenProjectFile;
  overleafChat: OverleafChat;
  overleafCollabOpen: boolean;
  overleafCollabTab: OverleafCollabTab;
  overleafComments: OverleafComments;
  overleafDocPaths: Map<string, string>;
  overleafLink: OverleafLink | null;
  overleafRealtime: OverleafRealtime;
  overleafTrackChanges: OverleafTrackChanges;
  setOverleafCollabOpen: Dispatch<SetStateAction<boolean>>;
  setOverleafCollabTab: Dispatch<SetStateAction<OverleafCollabTab>>;
  setViewRestore: Dispatch<SetStateAction<ViewRestoreRequest | null>>;
  source: string;
};

export function AppOverleafCollabDrawer(props: AppOverleafCollabDrawerProps) {
  const {
    overleafChat,
    overleafComments,
    overleafLink,
    overleafRealtime,
    overleafTrackChanges,
    setOverleafCollabOpen,
    setViewRestore,
  } = props;
  if (!props.overleafCollabOpen || !overleafLink) return null;
  // A comment's anchor is a character offset rather than a line, which is what
  // `viewRestore` takes.
  const revealAt = (path: string, position: number) => {
    setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
    setOverleafCollabOpen(false);
  };
  return (
    <Suspense fallback={null}>
      <OverleafCollabDrawer
        localComments={props.localComments}
        localCommentCount={props.localCommentCount}
        hasLocalComments={props.hasLocalComments}
        focusLocalComments={props.focusLocalComments}
        focusThreadId={props.focusThreadId}
        tab={props.overleafCollabTab}
        onTab={props.setOverleafCollabTab}
        projectName={overleafLink.projectName}
        onClose={() => setOverleafCollabOpen(false)}
        threads={overleafComments.threads}
        anchors={overleafComments.anchors}
        activeDocId={overleafRealtime.docId}
        pathForDoc={(id) => props.overleafDocPaths.get(id) ?? null}
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
