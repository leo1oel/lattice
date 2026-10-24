/**
 * The title bar's canvas toolbar as a project shows it: the document in front,
 * the history, Git and comment tools, and the Overleaf link's sync state, the
 * collaborators on the project and the unread conversation. A hook that
 * returns the toolbar rather than a component, which would render again with
 * every App render, each keystroke included.
 */
import { CanvasToolbar } from "../canvas/canvas-toolbar";
import { OverleafPresenceAvatars } from "../overleaf/overleaf-presence";
import type { AppearanceSettings } from "../settings/app-settings";
import type { EditorComments } from "./use-editor-comments";
import type { OpenDocuments } from "./use-open-documents";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { ToolDrawers } from "./use-tool-drawers";

export function useCanvasToolbar({
  documents: { paper: activePaper, asset: activeAsset, activeTab, dirty }, tools, commentCount, comments, inBrowserTab,
  onMoveWorkspace, hiddenTools, overleaf, onOverleafSync,
}: {
  documents: Pick<OpenDocuments, "paper" | "asset" | "activeTab" | "dirty">;
  tools: Pick<ToolDrawers, "open">;
  /** Unresolved comments on the document, local and Overleaf's alike. */
  commentCount: number;
  comments: Pick<EditorComments, "comments">;
  inBrowserTab: boolean;
  onMoveWorkspace: () => void;
  hiddenTools: AppearanceSettings["hiddenTitlebarTools"];
  overleaf: ReturnType<typeof useOverleafWorkspace>;
  onOverleafSync: () => void;
}) {
  const {
    overleafLink, overleafSyncMode, overleafRealtime, overleafPresence, overleafChat, overleafComments, overleafDocPaths,
  } = overleaf;
  return (
    <CanvasToolbar
      activePath={activePaper ? activePaper.title : activeTab}
      activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
      dirty={dirty}
      onHistory={() => tools.open("history")}
      onGit={() => tools.open("git")}
      commentCount={commentCount}
      onComments={() => tools.open("comments")}
      inBrowserTab={inBrowserTab}
      onMoveWorkspace={onMoveWorkspace}
      hiddenTools={hiddenTools}
      overleafLinked={overleafLink !== null}
      overleafSyncing={overleaf.overleafSyncing}
      overleafPending={overleaf.overleafRemoteChanges}
      overleafLiveEditing={overleafRealtime.liveFile}
      overleafChannel={overleafSyncMode === "live" ? overleafRealtime.status : "off"}
      overleafChannelDetail={overleafRealtime.detail}
      overleafProjectName={overleafLink?.projectName}
      overleafPresence={overleafPresence.peers.length ? (
        <OverleafPresenceAvatars
          peers={overleafPresence.peers}
          reconnecting={overleafPresence.reconnecting}
          pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
          onJump={overleaf.jumpToOverleafPeer}
          onMessageEveryone={() => {
            overleaf.setOverleafCollabTab("chat");
            tools.open("comments");
            void overleafChat.refresh();
          }}
        />
      ) : null}
      onOverleafSync={onOverleafSync}
      onOverleafOpenCurrent={overleafLink ? overleaf.openCurrentOverleafProject : undefined}
      onOverleafOpen={() => overleaf.setOverleafPickerOpen(true)}
      overleafUnreadChat={
        overleafChat.unread + overleafComments.threads.filter((thread) => !thread.resolved).length + overleafRealtime.changes.length
        + comments.comments.filter((comment) => !comment.resolved).length
      }
      onOverleafChat={() => {
        tools.open("comments");
        void overleafChat.refresh();
      }}
    />
  );
}
