/**
 * Overleaf's comment threads as the editor and the comments panel show them:
 * one comment per anchored thread, on the file and span it is anchored to.
 */
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { personColor, type PeopleHues } from "./overleaf-collab-people";
import type { OverleafComments } from "./use-overleaf-comments";

/** Marks a comment that lives on Overleaf rather than in this project; App's comment handlers route on it. */
export const OVERLEAF_COMMENT_PREFIX = "overleaf:";

export function projectOverleafEditorComments(
  threads: OverleafComments["threads"],
  anchors: OverleafComments["anchors"],
  docPaths: Map<string, string>,
  liveDocId: string | null,
  liveAnchors: Map<string, { threadId: string; position: number; quote: string }>,
  hues: PeopleHues = new Map(),
): EditorComment[] {
  // REST supplies ownership for every file; the joined document's live ranges
  // are authoritative, including anchors removed since the REST snapshot.
  const mergedAnchors = new Map([...anchors].filter(([, anchor]) => anchor.docId !== liveDocId));
  if (liveDocId) {
    for (const [id, anchor] of liveAnchors) mergedAnchors.set(id, { ...anchor, docId: liveDocId });
  }
  return threads.flatMap((thread) => {
    const anchor = mergedAnchors.get(thread.id);
    const path = anchor && docPaths.get(anchor.docId);
    if (!anchor || !path) return [];
    const [first, ...rest] = thread.messages;
    return [{
      id: `${OVERLEAF_COMMENT_PREFIX}${thread.id}`, number: 0, path,
      from: anchor.position, to: anchor.position + anchor.quote.length, quote: anchor.quote, prefix: "", suffix: "",
      body: first?.content ?? "", authorId: first?.authorEmail ?? "overleaf",
      authorColor: first && personColor(hues, { name: first.authorName, email: first.authorEmail, mine: first.mine }),
      // eslint-disable-next-line lingui/no-unlocalized-strings -- a name tagged with the product, the same in every locale
      authorName: first ? `${first.authorName} (Overleaf)` : "Overleaf", resolved: thread.resolved,
      replies: rest.map((message) => ({
        id: message.id, authorId: message.authorEmail ?? "overleaf", authorName: message.authorName,
        authorColor: personColor(hues, { name: message.authorName, email: message.authorEmail, mine: message.mine }),
        body: message.content, createdAt: new Date(message.timestamp).toISOString(),
      })),
      createdAt: new Date(first?.timestamp ?? 0).toISOString(),
      updatedAt: new Date(thread.messages.at(-1)?.timestamp ?? 0).toISOString(),
    }];
  });
}
