/**
 * The ranges a transaction changed, so the engine's decoration plugins can
 * look at what an edit touched instead of the whole document: a keystroke in
 * a long file must not cost a scan of every block (spec R-SRC-13, R-PERF-10).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export type Range = { from: number; to: number };

/** Changed ranges in the transaction's new document, widened to whole top-level blocks. */
export function changedBlockRanges(transaction: Transaction): Range[] {
  const { doc, mapping } = transaction;
  const ranges: Range[] = [];
  mapping.maps.forEach((map, index) => {
    const rest = mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) });
    });
  });
  // Attribute-only steps map no range; the node they changed is at their position.
  transaction.steps.forEach((step, index) => {
    const position = (step as unknown as { pos?: number }).pos;
    if (typeof position === "number") {
      const mapped = mapping.slice(index + 1).map(position);
      ranges.push({ from: mapped, to: mapped + 1 });
    }
  });
  return ranges.map((range) => topLevelSpan(doc, Math.min(range.from, doc.content.size), Math.min(Math.max(range.to, range.from), doc.content.size)));
}

/** The range of the top-level blocks that `from`…`to` touches. */
function topLevelSpan(doc: PmNode, from: number, to: number): Range {
  const start = doc.resolve(from);
  const end = doc.resolve(to);
  return {
    from: start.depth > 0 ? start.before(1) : from,
    to: end.depth > 0 ? end.after(1) : to,
  };
}

/** Whether any node named in `names` lies in the replaced parts of the old document. */
export function replacedAny(transaction: Transaction, names: ReadonlySet<string>): boolean {
  let found = false;
  transaction.steps.forEach((step, index) => {
    // Each step applies to the document as the steps before it left it.
    const doc = transaction.docs[index]!;
    step.getMap().forEach((oldStart, oldEnd) => {
      if (found || oldEnd <= oldStart) return;
      doc.nodesBetween(oldStart, Math.min(oldEnd, doc.content.size), (node) => {
        if (names.has(node.type.name)) found = true;
        return !found;
      });
    });
  });
  return found;
}

/** Whether any node named in `names` lies in `ranges` of `doc`. */
export function containsAny(doc: PmNode, ranges: readonly Range[], names: ReadonlySet<string>): boolean {
  let found = false;
  for (const range of ranges) {
    doc.nodesBetween(range.from, range.to, (node) => {
      if (names.has(node.type.name)) found = true;
      return !found;
    });
    if (found) break;
  }
  return found;
}
