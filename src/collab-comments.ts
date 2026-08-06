/**
 * Shared editor comments for a v2 room.
 *
 * Comments used to ride the comments file's "content" Y.Text as one JSON blob
 * that each publish replaced wholesale. Two peers could not both be right: the
 * blob a peer wrote was its own list, so a comment the other had just added was
 * overwritten, and merging on every publish instead would have resurrected
 * every deleted comment — `mergeEditorComments` is a union with no deletion
 * semantics, and a whole-document replace carries no record of what went away.
 *
 * A Y.Map keyed by comment id has both: an add is a key nobody else is writing,
 * a delete is a key removal Yjs propagates like any other, and a concurrent
 * edit of the same comment settles by Yjs's own last-writer-wins. The file
 * keeps its JSON shape on disk (git-friendly, and what local-only projects
 * read); only the wire representation changes. Same arrangement as the chat
 * document, whose "content" also stays empty while a Y.Array beside it carries
 * the messages.
 */
import * as Y from "yjs";
import { COLLAB_LOCAL_ORIGIN } from "./collab-session";
import {
  serializeEditorComments,
  tryParseEditorComments,
  type EditorComment,
} from "./editor-comment-data";

const COLLAB_COMMENTS_KEY = "comments";
const COLLAB_COMMENTS_META_KEY = "comments-meta";
const LEGACY_ADOPTED = "legacyAdopted";

export function collabCommentsMap(doc: Y.Doc): Y.Map<EditorComment> {
  return doc.getMap<EditorComment>(COLLAB_COMMENTS_KEY);
}

/** Map entries are peer-written, so a malformed one must not take the panel down. */
function isSharedComment(value: unknown): value is EditorComment {
  const comment = value as Partial<EditorComment> | null;
  return !!comment
    && typeof comment === "object"
    && typeof comment.id === "string"
    && typeof comment.path === "string"
    && typeof comment.body === "string"
    && Array.isArray(comment.replies);
}

/** Everything in the shared document, ordered the way the panel expects. */
export function readCollabComments(doc: Y.Doc): EditorComment[] {
  const comments: EditorComment[] = [];
  collabCommentsMap(doc).forEach((value) => {
    if (isSharedComment(value)) comments.push(value);
  });
  return comments.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

/**
 * Apply one local edit to the shared document.
 *
 * `previous` is what this client had before the edit, and it is what makes a
 * delete expressible: a comment missing from `next` is only removed when this
 * client actually had it, so a peer's comment that arrived after our last read
 * is left alone instead of being deleted by our stale view.
 */
export function writeCollabComments(
  doc: Y.Doc,
  next: readonly EditorComment[],
  previous: readonly EditorComment[],
): void {
  const map = collabCommentsMap(doc);
  const nextById = new Map(next.map((comment) => [comment.id, comment]));
  doc.transact(() => {
    for (const comment of previous) {
      if (!nextById.has(comment.id)) map.delete(comment.id);
    }
    for (const comment of next) {
      const existing = map.get(comment.id);
      // Rewriting an identical value would still broadcast an update and wake
      // every peer's observer, so only write what actually changed.
      if (!existing || JSON.stringify(existing) !== JSON.stringify(comment)) {
        map.set(comment.id, comment);
      }
    }
  }, COLLAB_LOCAL_ORIGIN);
}

/**
 * Adopt a room that predates the map: its comments are sitting in the file's
 * "content" text. Runs once per document, and the legacy text is never read
 * again afterwards.
 */
export function seedCollabCommentsFromContent(doc: Y.Doc): boolean {
  // Recorded in the document rather than inferred from an empty map: deleting
  // every comment empties the map too, and re-reading the legacy text then
  // resurrects exactly what was just deleted.
  const meta = doc.getMap<boolean>(COLLAB_COMMENTS_META_KEY);
  if (meta.get(LEGACY_ADOPTED) === true) return false;
  const map = collabCommentsMap(doc);
  const legacy = tryParseEditorComments(doc.getText("content").toString());
  doc.transact(() => {
    meta.set(LEGACY_ADOPTED, true);
    for (const comment of legacy ?? []) if (!map.has(comment.id)) map.set(comment.id, comment);
  }, COLLAB_LOCAL_ORIGIN);
  return Boolean(legacy?.length);
}

/** The room's comments in the on-disk file format, for the workspace mirror. */
export function collabCommentsContent(doc: Y.Doc): string {
  return serializeEditorComments(readCollabComments(doc));
}
