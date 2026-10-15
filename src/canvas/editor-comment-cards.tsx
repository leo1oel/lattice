import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CommentCard } from "../editor/comments/comment-card";
import type { CommentCardHosts, CommentCardMount } from "../editor/comments/editor-comments";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";

type CardActions = {
  author: { id: string; name: string };
  onResolve: (id: string) => void;
  onReply: (id: string, body: string) => void;
};

/**
 * The comment cards the source editors show over a comment's passage, drawn
 * into the hover tooltips CodeMirror places for them (`CommentCardHosts`).
 */
export function EditorCommentCards({ cards, ...actions }: CardActions & { cards: CommentCardHosts }) {
  const mounts = useSyncExternalStore(cards.subscribe, cards.getSnapshot);
  return mounts.map((mount) => createPortal(<HostedCard mount={mount} {...actions} />, mount.host, mount.key));
}

function HostedCard({ mount, ...actions }: CardActions & { mount: CommentCardMount }) {
  // A pinned card is left by clicking anywhere else, which still does what it does there.
  useDismissOnOutsidePointer(mount.pinned ? mount.host : null, mount.close);
  // Esc anywhere while the pinned card is open: focus may still be in the editor.
  useEffect(() => {
    if (!mount.pinned) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      mount.close();
      mount.focusEditor();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [mount]);
  return (
    <CommentCard
      comments={mount.comments}
      author={actions.author}
      replyingTo={mount.replyingTo}
      still={mount.pinned}
      onResolve={actions.onResolve}
      onReply={actions.onReply}
      onResolving={mount.fade}
      onReplyStart={mount.pinned ? undefined : mount.pin}
      onClose={() => {
        mount.close();
        mount.focusEditor();
      }}
    />
  );
}
