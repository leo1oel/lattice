/**
 * The title bar's canvas toolbar as a project shows it: the document in front,
 * the history, Git and comment tools, and the Overleaf link's sync state, the
 * collaborators on the project and the unread conversation. A hook that
 * returns the toolbar rather than a component, which would render again with
 * every App render, each keystroke included.
 */
import { useSyncExternalStore } from "react";
import { CanvasToolbar } from "../canvas/canvas-toolbar";
import { reviewMode } from "../history/review-mode-store";
import { OverleafPresenceAvatars } from "../overleaf/overleaf-presence";
import type { AppearanceSettings } from "../settings/app-settings";
import type { EditorComments } from "./use-editor-comments";
import type { OpenDocuments } from "./use-open-documents";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";
import type { ToolDrawers } from "./use-tool-drawers";

export function useCanvasToolbar({
  documents: { paper: activePaper, asset: activeAsset, activeTab, dirty, file, bufferText }, tools, commentCount, comments, inBrowserTab,
  onMoveWorkspace, hiddenTools, overleaf, onOverleafSync,
}: {
  documents: Pick<OpenDocuments, "paper" | "asset" | "activeTab" | "dirty" | "file" | "bufferText">;
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
  // The flag alone, not the state: this renders with App, and the store's
  // other changes (its project read at startup, each saved base) are not the toolbar's.
  const reviewing = useSyncExternalStore(reviewMode.subscribe, () => reviewMode.get().active);
  return (
    <CanvasToolbar
      activePath={activePaper ? activePaper.title : activeTab}
      activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
      dirty={dirty}
      onHistory={() => tools.open("history")}
      onGit={() => tools.open("git")}
      commentCount={commentCount}
      onComments={() => tools.open("comments")}
      reviewing={reviewing}
      onReview={() => void (reviewing
        ? reviewMode.confirmStop()
        : reviewMode.start(file ? { path: file, text: bufferText(file) ?? "" } : undefined))}
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
