/**
 * One drawer for everything that happens between people on an Overleaf
 * project: the comments on the text, and the chat beside it.
 *
 * They are one panel rather than two toolbar buttons because they are one
 * conversation from the writer's point of view — someone leaves a comment, you
 * answer it in chat, and both come down the same realtime channel.
 */
import { useEffect } from "react";
import { MessagesSquare, X } from "lucide-react";
import { motion } from "motion/react";
import type { OverleafMessage, OverleafThread } from "./app-types";
import { OverleafChatPanel } from "./overleaf-chat";
import { OverleafCommentsPanel } from "./overleaf-comments";

export type OverleafCollabTab = "comments" | "chat";

export function OverleafCollabDrawer(props: {
  tab: OverleafCollabTab;
  onTab: (tab: OverleafCollabTab) => void;
  projectName: string;
  onClose: () => void;

  threads: OverleafThread[];
  anchors: Map<string, { position: number; quote: string }>;
  documentOpen: boolean;
  commentsLoading: boolean;
  commentsError: string | null;
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onReveal: (position: number) => void;

  messages: OverleafMessage[];
  chatLoading: boolean;
  chatError: string | null;
  onSend: (content: string) => Promise<void>;
  unreadChat: number;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const openThreads = props.threads.filter((thread) => !thread.resolved).length;

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside
        className="history-drawer overleaf-collab-drawer"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div><MessagesSquare size={16} /><span>Overleaf collaboration</span></div>
          <button type="button" onClick={props.onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="view-switcher overleaf-collab-tabs">
          {([
            { id: "comments" as const, label: "comments", count: openThreads },
            { id: "chat" as const, label: "chat", count: props.unreadChat },
          ]).map((tab) => {
            const active = props.tab === tab.id;
            return (
              <button
                key={tab.id}
                className={active ? "active" : ""}
                onClick={() => props.onTab(tab.id)}
              >
                {active && (
                  <motion.span
                    layoutId="overleaf-collab-pill"
                    className="view-switcher-pill"
                    transition={{ type: "tween", ease: [0.65, 0, 0.35, 1], duration: 0.25 }}
                  />
                )}
                <span className="view-switcher-label">
                  {tab.label}
                  {tab.count > 0 ? <em>{tab.count}</em> : null}
                </span>
              </button>
            );
          })}
        </div>

        {props.tab === "comments" ? (
          <OverleafCommentsPanel
            threads={props.threads}
            anchors={props.anchors}
            documentOpen={props.documentOpen}
            loading={props.commentsLoading}
            error={props.commentsError}
            onReply={props.onReply}
            onResolve={props.onResolve}
            onDelete={props.onDeleteThread}
            onReveal={props.onReveal}
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
      </aside>
    </div>
  );
}
