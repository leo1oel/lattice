/**
 * One drawer for everything that happens between people on an Overleaf
 * project: the comments on the text, and the chat beside it.
 *
 * They are one panel rather than two toolbar buttons because they are one
 * conversation from the writer's point of view — someone leaves a comment, you
 * answer it in chat, and both come down the same realtime channel.
 */
import { useEffect } from "react";
import { useLingui } from "@lingui/react/macro";
import { MessagesSquare } from "lucide-react";
import { PanelHeader } from "../components/ui/panel-header";
import { SegmentedControl } from "../components/ui/segmented-control";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import type { OverleafMessage, OverleafThread } from "../app-types";
import { OverleafChatPanel } from "./overleaf-chat";
import { OverleafCommentsPanel } from "./overleaf-comments";
import { OverleafChangesPanel } from "./overleaf-changes";
import type { OverleafCommentAnchor } from "./overleaf-comment-anchors";
import type { TrackedChange } from "./use-overleaf-realtime";

export type OverleafCollabTab = "comments" | "chat" | "changes";

export function OverleafCollabDrawer(props: {
  tab: OverleafCollabTab;
  onTab: (tab: OverleafCollabTab) => void;
  projectName: string;
  onClose: () => void;

  threads: OverleafThread[];
  /** Every comment in the project, not only the open document's. */
  anchors: Map<string, OverleafCommentAnchor>;
  activeDocId: string | null;
  pathForDoc: (docId: string) => string | null;
  documentOpen: boolean;
  commentsLoading: boolean;
  commentsError: string | null;
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
  /** Jump to a comment, which may be in a file that is not open. */
  onRevealComment: (path: string, position: number) => void;
  /** Jump to a suggestion, which is always in the open document. */
  onReveal: (position: number) => void;

  messages: OverleafMessage[];
  chatLoading: boolean;
  chatError: string | null;
  onSend: (content: string) => Promise<void>;
  unreadChat: number;

  /** Suggestions in the open document, and what can be done about them. */
  changes: TrackedChange[];
  source: string;
  changeAuthorName: (userId: string | null) => string;
  canActOnChanges: boolean;
  changesBusy: string | null;
  changesError: string | null;
  onAcceptChanges: (changeIds: string[]) => Promise<void>;
  onRejectChanges: (changes: TrackedChange[]) => Promise<void>;
}) {
  const { t } = useLingui();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const openThreads = props.threads.filter((thread) => !thread.resolved).length;

  return (
    <ResizableDrawer className="overleaf-collab-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<MessagesSquare size={16} />}
          title={t`Overleaf collaboration`}
          onClose={props.onClose}
        />

        <SegmentedControl
          value={props.tab}
          onChange={props.onTab}
          ariaLabel={t`Overleaf collaboration view`}
          className="overleaf-collab-tabs"
          items={[
            {
              value: "comments",
              label: <>{t`Comments`}{openThreads > 0 ? <em>{openThreads}</em> : null}</>,
            },
            {
              value: "changes",
              label: <>{t`Changes`}{props.changes.length > 0 ? <em>{props.changes.length}</em> : null}</>,
            },
            {
              value: "chat",
              label: <>{t`Chat`}{props.unreadChat > 0 ? <em>{props.unreadChat}</em> : null}</>,
            },
          ]}
        />

        {props.tab === "changes" ? (
          <OverleafChangesPanel
            changes={props.changes}
            source={props.source}
            authorName={props.changeAuthorName}
            documentOpen={props.documentOpen}
            canAct={props.canActOnChanges}
            busy={props.changesBusy}
            error={props.changesError}
            onAccept={props.onAcceptChanges}
            onReject={props.onRejectChanges}
            onReveal={props.onReveal}
          />
        ) : props.tab === "comments" ? (
          <OverleafCommentsPanel
            threads={props.threads}
            anchors={props.anchors}
            activeDocId={props.activeDocId}
            pathForDoc={props.pathForDoc}
            loading={props.commentsLoading}
            error={props.commentsError}
            onReply={props.onReply}
            onResolve={props.onResolve}
            onDelete={props.onDeleteThread}
            onEditMessage={props.onEditMessage}
            onDeleteMessage={props.onDeleteMessage}
            onReveal={props.onRevealComment}
          />
        ) : (
          <OverleafChatPanel
            projectName={props.projectName}
            messages={props.messages}
            loading={props.chatLoading}
            error={props.chatError}
            onSend={props.onSend}
          />
        )}
    </ResizableDrawer>
  );
}
