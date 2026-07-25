/**
 * Grouping comment threads by the file they are actually in.
 *
 * `useOverleafComments` already carries every thread's anchor — document,
 * span, and quote — across the whole project, not just the open file. What
 * it does not do is decide how to present that: a reader wants the file on
 * screen first, then everything else broken out by file rather than lumped
 * into one pile, then whatever has no anchor left last. That grouping is pure
 * display logic with no Tauri or React dependency of its own, which is why it
 * lives here rather than inline in the panel.
 */
import type { OverleafCommentAnchor } from "./use-overleaf-comments";

export type { OverleafCommentAnchor };

export function anchorsByThreadId(anchors: OverleafCommentAnchor[]): Map<string, OverleafCommentAnchor> {
  return new Map(anchors.map((anchor) => [anchor.threadId, anchor]));
}

export type OverleafThreadGroup = {
  /** Stable React key: the open-file marker, a docId, or the orphan bucket. */
  key: string;
  label: string;
  threadIds: string[];
};

/**
 * Buckets thread ids by the file their anchor sits in, in the order a reader
 * wants them: the open file first, since that is what they came here to
 * check, then every other file with a live anchor — one group per file, so a
 * thread never gets lost in an undifferentiated "elsewhere" pile — then
 * orphaned threads last, because there is nothing in them to act on.
 */
export function groupThreadsByFile(
  threadIds: string[],
  anchors: Map<string, OverleafCommentAnchor>,
  activeDocId: string | null,
  pathForDoc: (docId: string) => string | null,
): OverleafThreadGroup[] {
  const here: string[] = [];
  const byDoc = new Map<string, string[]>();
  const orphaned: string[] = [];

  for (const id of threadIds) {
    const anchor = anchors.get(id);
    if (!anchor) {
      orphaned.push(id);
      continue;
    }
    if (anchor.docId === activeDocId) {
      here.push(id);
      continue;
    }
    const bucket = byDoc.get(anchor.docId);
    if (bucket) bucket.push(id);
    else byDoc.set(anchor.docId, [id]);
  }

  const groups: OverleafThreadGroup[] = [];
  if (here.length) groups.push({ key: "here", label: "In this file", threadIds: here });

  // Unresolved paths sort after named ones rather than interleaving among them.
  const elsewhere = [...byDoc.entries()]
    .map(([docId, ids]) => ({ docId, ids, path: pathForDoc(docId) }))
    .sort((a, b) => (a.path ?? "￿").localeCompare(b.path ?? "￿"));
  for (const { docId, ids, path } of elsewhere) {
    groups.push({ key: docId, label: path ?? "Another file in this project", threadIds: ids });
  }

  if (orphaned.length) {
    groups.push({ key: "orphaned", label: "No longer in the document", threadIds: orphaned });
  }
  return groups;
}
