/**
 * How Overleaf's suggestions ("tracked changes") move with the text, both
 * under ordinary edits and under edits sent as suggestions.
 *
 * Overleaf keeps the two kinds differently. A suggested insertion is text in
 * the document, so it is a span. A suggested deletion is text that has
 * already left the document: it occupies no offsets, only a point where the
 * removed text used to start. Treating it as a span covering its own length
 * strikes through, and quotes, whatever text happens to follow it.
 *
 * An edit sent as a suggestion changes the suggestions too: new text becomes
 * a suggested insertion, and removed text becomes a suggested deletion unless
 * it was itself only suggested, in which case removing it just withdraws that
 * much of the suggestion. The server keeps its own copy of these rules and
 * never tells the sender what it made of an update, so what is computed here
 * is provisional: shown at once, and replaced by the server's ranges as soon
 * as the document is quiet enough to read them back (see
 * `useSuggestionRefresh`). A provisional change has no id Overleaf knows, so
 * it cannot be accepted until then.
 */
import type { OtOp } from "./ot";
import type { TrackedChange } from "./overleaf-realtime-model";

/** Who an edit sent as a suggestion is attributed to, and their colour. */
export type Suggester = { userId: string | null; hue: number };

const PROVISIONAL = "provisional:";

/** Whether a change was worked out here rather than read from Overleaf. */
export const isProvisional = (change: Pick<TrackedChange, "id">) => change.id.startsWith(PROVISIONAL);

const provisionalId = () => `${PROVISIONAL}${crypto.randomUUID()}`;
const splice = (text: string, at: number, inserted: string) => text.slice(0, at) + inserted + text.slice(at);

/**
 * The suggestions after `ops`: ordinary edits when `by` is null, edits sent as
 * suggestions by `by` otherwise. Each op applies to the text the previous one
 * left, as in any OT operation.
 */
export function changesAfter(
  changes: readonly TrackedChange[], ops: readonly OtOp[], by: Suggester | null, timestamp = new Date().toISOString(),
): TrackedChange[] {
  let current = [...changes];
  for (const op of ops) {
    if (op.i) current = afterInsert(current, op.p, op.i, by, timestamp);
    else if (op.d) current = afterDelete(current, op.p, op.d, by, timestamp);
  }
  return current;
}

function afterInsert(changes: TrackedChange[], at: number, text: string, by: Suggester | null, timestamp: string): TrackedChange[] {
  // Typing inside, or at either edge of, one's own suggested insertion
  // extends it rather than starting another beside it.
  const host = by
    ? changes.find((change) => !change.deletion && change.userId === by.userId
      && change.position <= at && at <= change.position + change.text.length)
    : undefined;
  const next = changes.flatMap((change): TrackedChange[] => {
    if (change === host) return [{ ...change, text: splice(change.text, at - change.position, text) }];
    // Text typed at a deletion's point follows the removed text, the way a
    // replacement reads; typed at the start of an insertion it goes in front.
    // Either way it was not part of what that suggestion proposed.
    if (change.deletion) return at < change.position ? [{ ...change, position: change.position + text.length }] : [change];
    if (at <= change.position) return [{ ...change, position: change.position + text.length }];
    const offset = at - change.position;
    if (offset >= change.text.length) return [change];
    // An ordinary edit inside a suggested insertion becomes part of it, as
    // the server treats it; a suggestion inside someone else's splits theirs.
    if (!by) return [{ ...change, text: splice(change.text, offset, text) }];
    return [
      { ...change, text: change.text.slice(0, offset) },
      { ...change, id: provisionalId(), position: at + text.length, text: change.text.slice(offset) },
    ];
  });
  if (by && !host) {
    next.push({ id: provisionalId(), position: at, text, deletion: false, userId: by.userId, timestamp, hue: by.hue });
  }
  return next;
}

function afterDelete(changes: TrackedChange[], at: number, removed: string, by: Suggester | null, timestamp: string): TrackedChange[] {
  const end = at + removed.length;
  /** Characters of `removed` that were only ever suggested: deleting them withdraws them. */
  const withdrawn = new Array<boolean>(removed.length).fill(false);
  /** The suggester's own deletions the range reached, by offset into `removed`, to fold into one. */
  const folded: { offset: number; text: string }[] = [];
  const next = changes.flatMap((change): TrackedChange[] => {
    if (change.deletion) {
      const point = change.position;
      if (point < at) return [change];
      if (point > end) return [{ ...change, position: point - removed.length }];
      // Deleting up to or across one's own deletion makes one longer deletion,
      // the way backspacing through a word reads as one removal.
      if (by && change.userId === by.userId) {
        folded.push({ offset: point - at, text: change.text });
        return [];
      }
      return point === at ? [change] : [{ ...change, position: at }];
    }
    const start = change.position;
    const stop = start + change.text.length;
    if (stop <= at) return [change];
    if (start >= end) return [{ ...change, position: start - removed.length }];
    const from = Math.max(start, at);
    const to = Math.min(stop, end);
    withdrawn.fill(true, from - at, to - at);
    const text = change.text.slice(0, from - start) + change.text.slice(to - start);
    // A suggestion whose text was deleted outright has nothing left to accept
    // or reject; dropping it is better than offering a button that would act
    // on whatever moved into its place.
    return text ? [{ ...change, position: Math.min(start, at), text }] : [];
  });
  if (!by) return next;
  let text = "";
  for (let offset = 0; offset <= removed.length; offset += 1) {
    for (const fold of folded) if (fold.offset === offset) text += fold.text;
    if (offset < removed.length && !withdrawn[offset]) text += removed[offset];
  }
  if (text) next.push({ id: provisionalId(), position: at, text, deletion: true, userId: by.userId, timestamp, hue: by.hue });
  return next;
}
