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
import type { OverleafMessage, OverleafThread } from "../app-types";
import { ChatPanel } from "../components/ui/chat-panel";
import { InlineMessage } from "../components/ui/inline-message";
import { OverleafCommentsPanel } from "./overleaf-comments";
import { OverleafChangesPanel } from "./overleaf-changes";
import type { OverleafCommentAnchor } from "./use-overleaf-comments";
import type { TrackedChange } from "./use-overleaf-realtime";
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
  const [commentSource, setCommentSource] = useState(props.focusLocalComments ? "local" : "overleaf");
  const projectName = props.projectName || t`this project`;
  const chatMessages = useMemo(() => props.messages.map((message) => ({
    id: message.id,
    authorKey: `${message.mine}:${message.authorName}`,
    authorName: message.authorName,
    body: message.content,
    at: message.timestamp,
    mine: message.mine,
  })), [props.messages]);
  const openThreads = props.threads.filter((thread) => !thread.resolved).length + (props.localCommentCount ?? 0);
  const badge = (count: number) => (count > 0 ? <em>{count}</em> : null);

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
            { value: "changes", label: <>{t`Changes`}{badge(props.changes.length)}</> },
            { value: "chat", label: <>{t`Chat`}{badge(props.unreadChat)}</> },
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
          <>
            {props.hasLocalComments && <SegmentedControl
              value={commentSource}
              onChange={setCommentSource}
              ariaLabel={t`Comment source`}
              className="overleaf-collab-tabs"
              items={[
                { value: "overleaf", label: "Overleaf" },
                { value: "local", label: <>{t`Local comments`}{badge(props.localCommentCount ?? 0)}</> },
              ]}
            />}
            {commentSource === "local" && props.hasLocalComments ? (
              <>
                <p className="overleaf-local-comments-note">{t`These comments stay in Lattice and are not sent to Overleaf.`}</p>
                {props.localComments}
              </>
            ) : (
              <OverleafCommentsPanel
                focusThreadId={props.focusThreadId}
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
            )}
          </>
        ) : (
          <ChatPanel
            header={(
              <>
                <p className="drawer-copy">
                  {t({
                    message: `The same conversation as the chat panel in ${projectName} on Overleaf. Messages appear on both sides as they are sent`,
                  })}
                </p>
                {props.chatError && <InlineMessage level="error" className="overleaf-chat-inline">{props.chatError}</InlineMessage>}
              </>
            )}
            messages={chatMessages}
            listClassName="overleaf-chat-list"
            listLabel={t`Overleaf chat messages`}
            loading={props.chatLoading}
            loadingText={t`Loading the conversation…`}
            emptyText={props.chatError ? undefined : t`No messages yet. Say something and everyone in the project sees it`}
            placeholder={t`Message your collaborators…`}
            onSend={props.onSend}
          />
        )}
    </ResizableDrawer>
  );
}
