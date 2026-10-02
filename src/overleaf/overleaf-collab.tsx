/**
 * One drawer for everything that happens between people on an Overleaf
 * project: the comments on the text, and the chat beside it.
 *
 * They are one panel rather than two toolbar buttons because they are one
 * conversation from the writer's point of view — someone leaves a comment, you
 * answer it in chat, and both come down the same realtime channel.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { MessagesSquare } from "lucide-react";
import { PanelHeader } from "../components/ui/panel-header";
import { SegmentedControl } from "../components/ui/segmented-control";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { ChatPanel } from "../components/ui/chat-panel";
import { InlineMessage } from "../components/ui/inline-message";
import { CommentVisibilityFilter } from "../editor/comments/comment-visibility-filter";
import { OverleafCommentsPanel } from "./overleaf-comments";
import { OverleafChangesPanel } from "./overleaf-changes";
import type { useOverleafChat } from "./use-overleaf-chat";
import type { OverleafComments } from "./use-overleaf-comments";
import type { useOverleafRealtime } from "./use-overleaf-realtime";
import type { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import "./overleaf-collab.css";

export type OverleafCollabTab = "comments" | "chat" | "changes";

export function OverleafCollabDrawer(props: {
  localComments?: ReactNode;
  localCommentCount?: number;
  hasLocalComments?: boolean;
  focusLocalComments?: boolean;
  focusThreadId?: string | null;
  tab: OverleafCollabTab;
  onTab: (tab: OverleafCollabTab) => void;
  onClose: () => void;
  comments: Pick<OverleafComments, "threads" | "anchors" | "loading" | "error" | "reply" | "setResolved" | "remove" | "editMessage" | "deleteMessage">;
  chat: Pick<ReturnType<typeof useOverleafChat>, "messages" | "loading" | "error" | "send" | "unread">;
  trackChanges: Pick<ReturnType<typeof useOverleafTrackChanges>, "authorName" | "busy" | "error" | "accept" | "reject">;
  /** The open document on the live channel: Overleaf's id for it (null when none), its suggestions, and whether you may act on them. */
  realtime: Pick<ReturnType<typeof useOverleafRealtime>, "docId" | "changes" | "canWrite">;
  pathForDoc: (docId: string) => string | null;
  source: string;
  /** Jump to a comment, which may be in a file that is not open. */
  onRevealComment: (path: string, position: number) => void;
  /** Jump to a suggestion, which is always in the open document. */
  onReveal: (position: number) => void;
}) {
  const { t } = useLingui();
  const [commentSource, setCommentSource] = useState(props.focusLocalComments ? "local" : "overleaf");
  const [showResolved, setShowResolved] = useState(!!props.focusThreadId);
  const { comments, chat, trackChanges, realtime } = props;
  const chatMessages = useMemo(() => chat.messages.map((message) => ({
    id: message.id,
    authorKey: `${message.mine}:${message.authorName}`,
    authorName: message.authorName,
    body: message.content,
    at: message.timestamp,
    mine: message.mine,
  })), [chat.messages]);
  const openThreads = comments.threads.filter((thread) => !thread.resolved).length + (props.localCommentCount ?? 0);
  const badge = (count: number) => (count > 0 ? <em>{count}</em> : null);
  const showLocal = commentSource === "local" && !!props.hasLocalComments;
  const hasResolved = comments.threads.some((thread) => thread.resolved);
  const threadCount = comments.threads.length;

  return (
    <ResizableDrawer className="overleaf-collab-drawer editor-comments-content" onClose={props.onClose}>
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
            { value: "comments", label: <>{t`Comments`}{badge(openThreads)}</> },
            { value: "changes", label: <>{t`Changes`}{badge(realtime.changes.length)}</> },
            { value: "chat", label: <>{t`Chat`}{badge(chat.unread)}</> },
          ]}
        />

        {props.tab === "changes" ? (
          <OverleafChangesPanel
            changes={realtime.changes}
            source={props.source}
            authorName={trackChanges.authorName}
            documentOpen={realtime.docId !== null}
            canAct={realtime.canWrite}
            busy={trackChanges.busy}
            error={trackChanges.error}
            onAccept={trackChanges.accept}
            onReject={trackChanges.reject}
            onReveal={props.onReveal}
          />
        ) : props.tab === "comments" ? (
          <>
            {/* Which comments to list shares one row with the resolved filter,
                rather than stacking a second full-width switcher under the tabs. */}
            {(props.hasLocalComments || (!showLocal && hasResolved)) && (
              <div className="overleaf-comments-toolbar">
                {props.hasLocalComments && (
                  <SegmentedControl
                    value={commentSource}
                    onChange={setCommentSource}
                    ariaLabel={t`Comment source`}
                    className="overleaf-comment-source"
                    items={[
                      { value: "overleaf", label: "Overleaf" },
                      { value: "local", label: <>{t({ message: "Local", context: "comment source" })}{badge(props.localCommentCount ?? 0)}</> },
                    ]}
                  />
                )}
                {!showLocal && hasResolved && (
                  <CommentVisibilityFilter
                    showResolved={showResolved}
                    onChange={setShowResolved}
                    openLabel={t`Unresolved`}
                    resolvedLabel={t({ message: `All (${threadCount})` })}
                  />
                )}
              </div>
            )}
            {showLocal ? (
              <>
                <p className="overleaf-local-comments-note">{t`These comments stay in Lattice and are not sent to Overleaf.`}</p>
                {props.localComments}
              </>
            ) : (
              <OverleafCommentsPanel
                focusThreadId={props.focusThreadId}
                threads={comments.threads}
                anchors={comments.anchors}
                activeDocId={realtime.docId}
                pathForDoc={props.pathForDoc}
                loading={comments.loading}
                error={comments.error}
                onReply={comments.reply}
                onResolve={comments.setResolved}
                onDelete={comments.remove}
                onEditMessage={comments.editMessage}
                onDeleteMessage={comments.deleteMessage}
                onReveal={props.onRevealComment}
                showResolved={showResolved}
              />
            )}
          </>
        ) : (
          <ChatPanel
            header={(
              <>
                {chat.error && <InlineMessage level="error" className="overleaf-chat-inline">{chat.error}</InlineMessage>}
              </>
            )}
            messages={chatMessages}
            listClassName="overleaf-chat-list"
            listLabel={t`Overleaf chat messages`}
            loading={chat.loading}
            loadingText={t`Loading the conversation…`}
            emptyText={chat.error ? undefined : t`No messages yet. Say something and everyone in the project sees it`}
            placeholder={t`Message your collaborators…`}
            onSend={chat.send}
          />
        )}
    </ResizableDrawer>
  );
}
