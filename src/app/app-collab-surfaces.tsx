/**
 * Collaboration: the Lattice Shares dialog and the Overleaf collaboration
 * drawer (comments, chat and tracked changes for a linked Overleaf project).
 *
 * `CollabDialog` is re-exported so the Welcome screen's join-only rendering in
 * App.tsx and the in-project one below share a single `lazy()` wrapper — two
 * wrappers over one specifier resolve to the same chunk, but they are two
 * component identities, so a dialog open across that boundary would remount.
 */
import { lazy, Suspense, type Dispatch, type RefObject, type SetStateAction } from "react";
import { SHARE_SOURCE } from "./use-collab-v2-session";
import { notifyWarning } from "../telemetry/app-notify";
import type { CollabDialogMode } from "../collab/collab-dialog";
import type { CollabPeer, CollabStatus, EditorCollabSession } from "../collab/collab-session";
import type { CollabProjectRecordV2 } from "../collab/collab-rooms";
import type { CollabChat } from "../collab/use-collab-chat";
import type { OverleafChat } from "../overleaf/use-overleaf-chat";
import type { OverleafComments } from "../overleaf/use-overleaf-comments";
import type { OverleafRealtime } from "../overleaf/use-overleaf-realtime";
import type { OverleafTrackChanges } from "../overleaf/use-overleaf-track-changes";
import type { OverleafCollabTab } from "../overleaf/overleaf-collab";
import type {
  EditorPaneId,
  OverleafLink,
} from "../app-types";

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
  const {
    closeRecentProjectV2,
    collabCanWrite,
    collabChat,
    collabFileCount,
    collabHost,
    collabInvite,
    collabMode,
    collabName,
    collabOpen,
    collabPeerList,
    collabPeers,
    collabProjectName,
    collabRole,
    collabRoom,
    collabSession,
    collabStatus,
    collabStatusDetail,
    copyCollabInvite,
    disconnectCollab,
    editorCommentAuthorId,
    forgetRecentProjectV2,
    joinCollabShare,
    leaveHostShareSession,
    openTexSetupWizard,
    recentProjectsV2,
    rejoinCollabProjectV2,
    removeCollabPeer,
    renameRecentProjectV2,
    setCollabInvite,
    setCollabMode,
    setCollabName,
    setCollabOpen,
    setCollabProjectName,
    setCollabRoom,
    startCollabShare,
  } = props;
  return (
    <>
      {collabOpen && (
        <Suspense fallback={null}>
          <CollabDialog
            open
            mode={collabMode}
            role={collabRole}
            joinOnly={false}
            chatMessages={collabChat.messages}
            chatSelfId={editorCommentAuthorId}
            chatUnread={collabChat.unread}
            onChatSend={(body) => {
              // The server rejects every write frame from a read grant with a
              // 4403 close that permanently stops the doc's client — a
              // read-only guest's send must not reach the doc at all.
              if (collabSession?.canWrite === false || !collabCanWrite) {
                notifyWarning(SHARE_SOURCE, "Read-only guests cannot send chat messages");
                return;
              }
              collabChat.send(body);
            }}
            onChatOpen={collabChat.markRead}
            host={collabHost}
            room={collabRoom}
            displayName={collabName}
            projectName={collabProjectName}
            inviteText={collabInvite}
            status={collabStatus}
            statusDetail={collabStatusDetail}
            peerCount={collabPeers}
            peers={collabPeerList}
            fileCount={collabFileCount}
            connectedRoom={collabSession?.room ?? null}
            onClose={() => setCollabOpen(false)}
            onModeChange={setCollabMode}
            onRoomChange={setCollabRoom}
            onDisplayNameChange={setCollabName}
            onProjectNameChange={setCollabProjectName}
            onInviteChange={setCollabInvite}
            onStartShare={startCollabShare}
            onJoinShare={joinCollabShare}
            recentProjectsV2={recentProjectsV2}
            onRejoinProjectV2={rejoinCollabProjectV2}
            onForgetProjectV2={forgetRecentProjectV2}
            onRenameProjectV2={renameRecentProjectV2}
            onCloseProjectV2={closeRecentProjectV2}
            onDisconnect={disconnectCollab}
            onLeaveShare={() => void leaveHostShareSession()}
            onCopyInvite={copyCollabInvite}
            onRemovePeer={removeCollabPeer}
            onInstallTex={openTexSetupWizard}
          />
        </Suspense>
      )}
    </>
  );
}

export type AppOverleafCollabDrawerProps = {
  activeFileRef: RefObject<string>;
  openProjectFile: (path: string, line?: number, targetPane?: EditorPaneId, options?: { revealSource?: boolean; }) => Promise<void>;
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
  setViewRestore: Dispatch<SetStateAction<{ path: string; cursor: number; scrollTop: number; id: string; } | null>>;
  source: string;
};

export function AppOverleafCollabDrawer(props: AppOverleafCollabDrawerProps) {
  const {
    activeFileRef,
    openProjectFile,
    overleafChat,
    overleafCollabOpen,
    overleafCollabTab,
    overleafComments,
    overleafDocPaths,
    overleafLink,
    overleafRealtime,
    overleafTrackChanges,
    setOverleafCollabOpen,
    setOverleafCollabTab,
    setViewRestore,
    source,
  } = props;
  return (
    <>
      {overleafCollabOpen && overleafLink && (
        <Suspense fallback={null}>
          <OverleafCollabDrawer
            tab={overleafCollabTab}
            onTab={setOverleafCollabTab}
            projectName={overleafLink.projectName}
            onClose={() => setOverleafCollabOpen(false)}
            threads={overleafComments.threads}
            anchors={overleafComments.anchors}
            activeDocId={overleafRealtime.docId}
            pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
            documentOpen={overleafRealtime.docId !== null}
            commentsLoading={overleafComments.loading}
            commentsError={overleafComments.error}
            onReply={overleafComments.reply}
            onResolve={overleafComments.setResolved}
            onDeleteThread={overleafComments.remove}
            onEditMessage={overleafComments.editMessage}
            onDeleteMessage={overleafComments.deleteMessage}
            onRevealComment={(path, position) => {
            // The comment may be on a file that is not open, so open it first
            // and place the caret after. A comment's anchor is a character
            // offset rather than a line, which is what `viewRestore` takes.
            void openProjectFile(path).then(() => {
              setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
              setOverleafCollabOpen(false);
            });
          }}
          onReveal={(position) => {
            const path = activeFileRef.current;
            if (!path) return;
            setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
            setOverleafCollabOpen(false);
          }}
          messages={overleafChat.messages}
          chatLoading={overleafChat.loading}
          chatError={overleafChat.error}
          onSend={overleafChat.send}
          unreadChat={overleafChat.unread}
          changes={overleafRealtime.changes}
          source={source}
          changeAuthorName={overleafTrackChanges.authorName}
          canActOnChanges={overleafRealtime.canWrite}
          changesBusy={overleafTrackChanges.busy}
          changesError={overleafTrackChanges.error}
          onAcceptChanges={overleafTrackChanges.accept}
            onRejectChanges={overleafTrackChanges.reject}
          />
        </Suspense>
      )}
    </>
  );
}
