/**
 * The Overleaf project chat.
 *
 * Collaborators who stayed in the browser talk here, so this has to feel like
 * the chat they are looking at: their messages on the left, yours on the
 * right, newest at the bottom, and a composer that sends on Enter. Everything
 * arrives on the realtime channel, so there is no refresh button to hunt for.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { InfinityLoader } from "./components/ui/activity-icons";
import { IconButton } from "./components/ui/icon-button";
import { Textarea } from "./components/ui/textarea";
import { resizeTextareaToContent } from "./components/ui/auto-resize-textarea";
import type { OverleafMessage } from "./app-types";
import "./overleaf-chat.css";

/** "14:32" for today, "12 Mar 14:32" for anything older. */
export function formatStamp(timestamp: number) {
  if (!timestamp) return "";
  const when = new Date(timestamp);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  return when.toLocaleString(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function OverleafChatPanel(props: {
  projectName: string;
  messages: OverleafMessage[];
  loading: boolean;
  error: string | null;
  onSend: (content: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow with the text instead of scrolling inside a fixed box, the way the
  // agent composer does — a two-line box with its own scrollbar is a worse
  // place to write than one that simply gets taller.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    resizeTextareaToContent(composer);
  }, [draft]);

  // Anchor to the newest message the way every chat does, before paint so it
  // never looks like it scrolled.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [props.messages]);

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const submit = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await props.onSend(content);
      setDraft("");
    } catch {
      // The hook surfaces the reason; keep the text so nothing is lost.
    }
    setSending(false);
    composerRef.current?.focus();
  };

  return (
    <>
      <p className="drawer-copy">
        The same conversation as the chat panel in {props.projectName || "this project"} on
        Overleaf. Messages appear on both sides as they are sent.
      </p>

      {props.error && <p className="overleaf-chat-error" role="alert">{props.error}</p>}

      <div className="overleaf-chat-list" ref={listRef}>
        {props.loading && !props.messages.length && (
          <p className="git-empty"><InfinityLoader size={13} /> Loading the conversation…</p>
        )}
        {!props.loading && !props.messages.length && !props.error && (
          <p className="git-empty">No messages yet. Say something and everyone in the project sees it.</p>
        )}
        {props.messages.map((message, index) => {
          // One name above a run of messages reads as a conversation rather
          // than a log; repeat it only when the speaker changes.
          const previous = props.messages[index - 1];
          const grouped = previous
            && previous.mine === message.mine
            && previous.authorName === message.authorName
            && message.timestamp - previous.timestamp < 5 * 60_000;
          return (
            <article
              className={`overleaf-chat-message${message.mine ? " mine" : ""}${grouped ? " grouped" : ""}`}
              key={message.id}
            >
              {!grouped && (
                <div className="overleaf-chat-meta">
                  <span>{message.mine ? "You" : message.authorName}</span>
                  <time>{formatStamp(message.timestamp)}</time>
                </div>
              )}
              <p>{message.content}</p>
            </article>
          );
        })}
      </div>

      <div className="overleaf-chat-composer">
        <Textarea
          ref={composerRef}
          rows={1}
          value={draft}
          placeholder="Message your collaborators…"
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // While an input method is composing, Enter is choosing a
            // candidate — sending then would cut a Chinese word in half and
            // fire off whatever was on screen.
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") {
              return;
            }
            // Enter sends, Shift+Enter breaks the line — what every chat does.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <IconButton
          label="Send message"
          tooltip={false}
          tone="primary"
          disabled={!draft.trim() || sending}
          onClick={() => void submit()}
        >
          {sending ? <InfinityLoader size={14} /> : <SendHorizontal size={14} />}
        </IconButton>
      </div>
    </>
  );
}
