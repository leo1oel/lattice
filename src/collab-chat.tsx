/**
 * The chat for a Lattice Share session.
 *
 * A Share room already carries named cursors and editor comments, but a
 * comment only exists pinned to a piece of text — there was nowhere to say
 * "give me five minutes" or "check the abstract before you build." This is
 * the same conversation surface Overleaf gives its collaborators (see
 * overleaf-chat.tsx, which this mirrors), wired onto the CRDT instead of a
 * server: there is no send request to await and no history to fetch, so it
 * behaves like a chat that has always been there, even for someone who joins
 * an hour into the conversation.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "./components/ui/button";
import { IconButton } from "./components/ui/icon-button";
import { Textarea } from "./components/ui/textarea";
import { resizeTextareaToContent } from "./components/ui/auto-resize-textarea";
import type { CollabChatMessage } from "./collab-session";
import "./collab-chat.css";

/**
 * "14:32" for today, "12 Mar 14:32" for anything older. Not exported: a
 * component file that also exports a plain helper defeats Fast Refresh, so
 * this stays private the way overleaf-chat.tsx's version would if it were
 * added today (its export predates the current lint config).
 */
function formatCollabChatStamp(at: number): string {
  if (!at) return "";
  const when = new Date(at);
  const now = new Date();
  const sameDay = when.toDateString() === now.toDateString();
  return when.toLocaleString(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function CollabChatPanel(props: {
  messages: CollabChatMessage[];
  /** This device's stable author id, so its own messages side right and say "You". */
  selfId: string;
  onSend: (body: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [hasMessagesBelow, setHasMessagesBelow] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const nearBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);

  // Grow with the text instead of scrolling inside a fixed box, the way the
  // Overleaf chat composer and the agent composer both do.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    resizeTextareaToContent(composer);
  }, [draft]);

  // Anchor the initial history to the newest message. After that, follow only
  // while the reader is already near the bottom; a realtime message must not
  // pull someone away from the older part of the conversation they chose to
  // read.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const previousCount = previousMessageCountRef.current;
    const conversationReset = props.messages.length < previousCount;
    const receivedMessages = props.messages.length > previousCount;
    const loadedInitialHistory = previousCount === 0 && props.messages.length > 0;

    if (conversationReset || props.messages.length === 0) {
      nearBottomRef.current = true;
      setHasMessagesBelow(false);
      list.scrollTop = props.messages.length > 0 ? list.scrollHeight : 0;
    } else if (nearBottomRef.current || loadedInitialHistory) {
      list.scrollTop = list.scrollHeight;
      nearBottomRef.current = true;
      setHasMessagesBelow(false);
    } else if (receivedMessages) {
      setHasMessagesBelow(true);
    }

    previousMessageCountRef.current = props.messages.length;
  }, [props.messages]);

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    // A local Y.Array push cannot fail the way a network request can, so
    // there is no error path here to preserve the draft against — clear it
    // and move on, same as the outcome overleaf-chat.tsx reaches on success.
    props.onSend(content);
    setDraft("");
    composerRef.current?.focus();
  };

  const scrollToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    nearBottomRef.current = true;
    setHasMessagesBelow(false);
    list.focus({ preventScroll: true });
  };

  return (
    <>
      <p className="drawer-copy">
        Visible to everyone currently in this share. History lives in the session itself, so
        anyone who joins later sees what was already said.
      </p>

      <div
        className="collab-chat-list native-hover-scrollbar"
        ref={listRef}
        role="region"
        aria-label="Chat messages"
        tabIndex={0}
        onScroll={(event) => {
          const list = event.currentTarget;
          const distanceFromBottom = list.scrollHeight - list.clientHeight - list.scrollTop;
          const nearBottom = distanceFromBottom <= 32;
          nearBottomRef.current = nearBottom;
          if (nearBottom) setHasMessagesBelow(false);
        }}
      >
        {!props.messages.length && (
          <p className="git-empty">No messages yet. Say something and everyone in the room sees it.</p>
        )}
        {props.messages.map((message, index) => {
          // One name above a run of messages reads as a conversation rather
          // than a log; repeat it only when the speaker changes. Grouped by
          // authorId, not name — two people can share a display name.
          const previous = props.messages[index - 1];
          const mine = message.authorId === props.selfId;
          const grouped = previous
            && previous.authorId === message.authorId
            && message.at - previous.at < 5 * 60_000;
          return (
            <article
              className={`collab-chat-message${mine ? " mine" : ""}${grouped ? " grouped" : ""}`}
              key={message.id}
            >
              {!grouped && (
                <div className="collab-chat-meta">
                  <span>{mine ? "You" : message.authorName}</span>
                  <time>{formatCollabChatStamp(message.at)}</time>
                </div>
              )}
              <p>{message.body}</p>
            </article>
          );
        })}
      </div>

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {hasMessagesBelow ? "New messages are available." : ""}
      </span>
      {hasMessagesBelow && (
        <Button
          size="compact"
          variant="secondary"
          className="collab-chat-latest-button"
          onClick={scrollToLatest}
        >
          New messages · Jump to latest
        </Button>
      )}

      <div className="collab-chat-composer">
        <Textarea
          ref={composerRef}
          rows={1}
          value={draft}
          placeholder="Message everyone in this share…"
          aria-label="Message"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // While an input method is composing, Enter is choosing a
            // candidate — sending then would cut a Chinese word in half and
            // fire off whatever happened to be on screen.
            if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") {
              return;
            }
            // Enter sends, Shift+Enter breaks the line — what every chat does.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <IconButton
          label="Send message"
          tooltip={false}
          tone="primary"
          disabled={!draft.trim()}
          onClick={submit}
        >
          <SendHorizontal size={14} />
        </IconButton>
      </div>
    </>
  );
}
