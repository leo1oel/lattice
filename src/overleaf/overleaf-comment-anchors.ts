/**
 * Grouping comment threads by the file they are actually in: the file on
 * screen first, then every other file with a live anchor — one group per file,
 * so a thread never gets lost in an undifferentiated "elsewhere" pile — then
 * orphaned threads, whose span was edited away, last. Pure display logic, kept
 * out of the panel so it can be tested on its own.
 */
import type { OverleafCommentAnchor } from "./use-overleaf-comments";

export type OverleafThreadGroup = {
  /** Stable React key: the open-file marker, a docId, or the orphan bucket. */
  key: string;
  label: string;
  threadIds: string[];
};

export function groupThreadsByFile(
  threadIds: string[],
  anchors: Map<string, OverleafCommentAnchor>,
  activeDocId: string | null,
  pathForDoc: (docId: string) => string | null,
  labels: { currentFile: string; unknownFile: string; orphaned: string },
): OverleafThreadGroup[] {
  const buckets = new Map<string, string[]>();
  for (const id of threadIds) {
    const docId = anchors.get(id)?.docId;
    const key = docId === undefined ? "orphaned" : docId === activeDocId ? "here" : docId;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  }
  const group = (key: string, label: string) => ({ key, label, threadIds: buckets.get(key)! });
  // Unresolved paths sort after named ones rather than interleaving among them.
  const elsewhere = [...buckets.keys()]
    .filter((key) => key !== "here" && key !== "orphaned")
    .map((docId) => ({ docId, path: pathForDoc(docId) }))
    .sort((a, b) => (a.path ?? "￿").localeCompare(b.path ?? "￿"));
  return [
    ...(buckets.has("here") ? [group("here", labels.currentFile)] : []),
    ...elsewhere.map(({ docId, path }) => group(docId, path ?? labels.unknownFile)),
    ...(buckets.has("orphaned") ? [group("orphaned", labels.orphaned)] : []),
  ];
}
