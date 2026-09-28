/**
 * The chat for a Lattice Share session: the shared chat surface wired onto
 * the room's CRDT rather than a server, so there is no send to await and no
 * history to fetch — someone who joins an hour in sees it all.
 */
import { useMemo } from "react";
import { ChatPanel } from "../components/ui/chat-panel";
import type { CollabChatMessage } from "./use-collab-chat";

export function CollabChatPanel(props: {
  messages: CollabChatMessage[];
  /** This device's stable author id, so its own messages side right and say "You". */
  selfId: string;
  onSend: (body: string) => void;
}) {
  const messages = useMemo(() => props.messages.map((message) => ({
    id: message.id,
    // Grouped by author id, not name — two people can share a display name.
    authorKey: message.authorId,
    authorName: message.authorName,
    body: message.body,
    at: message.at,
    mine: message.authorId === props.selfId,
  })), [props.messages, props.selfId]);
  return (
    <ChatPanel
      header={(
        <p className="drawer-copy">
          Visible to everyone currently in this share. History lives in the session itself, so
          anyone who joins later sees what was already said
        </p>
      )}
      messages={messages}
      listClassName="collab-chat-list native-hover-scrollbar"
      listLabel="Chat messages"
      emptyText="No messages yet. Say something and everyone in the room sees it"
      placeholder="Message everyone in this share…"
      onSend={props.onSend}
    />
  );
}
