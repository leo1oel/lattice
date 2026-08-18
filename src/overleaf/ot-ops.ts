/**
 * Turning text edits into Overleaf's operational-transform ops, and back.
 *
 * Overleaf's realtime protocol does not exchange whole documents — it exchanges
 * positioned inserts and deletes. That is what lets two people type in the same
 * paragraph without either version being overwritten, so every local edit has
 * to be expressed this way before it can be sent.
 */

/** One OT operation: insert `i` or delete `d`, both at character offset `p`. */
export type OtOp = { p: number; i?: string; d?: string };

/**
 * Describe the change from `before` to `after` as ops.
 *
 * Editing is overwhelmingly one contiguous change at a time — typing, pasting,
 * deleting a selection — so this narrows to the differing middle by matching
 * the common prefix and suffix. That produces exactly the same ops the web
 * editor would send for the same keystroke, and never invents overlapping
 * edits the server would have to reconcile.
 */
export function diffToOps(before: string, after: string): OtOp[] {
  if (before === after) return [];

  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);

  const ops: OtOp[] = [];
  // Delete first: the insert's position is then expressed against the text
  // that remains, which is what the server expects.
  if (removed) ops.push({ p: prefix, d: removed });
  if (inserted) ops.push({ p: prefix, i: inserted });
  return ops;
}

/**
 * Apply ops to a document, in order. Used for updates arriving from other
 * people so the local copy ends up byte-identical to the server's.
 *
 * Returns null when an op does not fit the text it is applied to (a delete
 * whose content does not match, or a position past the end) — a sign the local
 * copy has drifted, which the caller should recover from by re-fetching the
 * document rather than writing something wrong to disk.
 */
export function applyOps(content: string, ops: OtOp[]): string | null {
  let text = content;
  for (const op of ops) {
    if (op.p < 0 || op.p > text.length) return null;
    if (typeof op.d === "string") {
      if (text.slice(op.p, op.p + op.d.length) !== op.d) return null;
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
    }
    if (typeof op.i === "string") {
      if (op.p > text.length) return null;
      text = text.slice(0, op.p) + op.i + text.slice(op.p);
    }
  }
  return text;
}

/**
 * Shift a caret offset so it keeps its place after remote ops are applied.
 * Without this an edit above the cursor drags it, and the person typing loses
 * their spot mid-sentence.
 */
export function transformCaret(offset: number, ops: OtOp[]): number {
  let caret = offset;
  for (const op of ops) {
    if (typeof op.d === "string") {
      if (op.p + op.d.length <= caret) caret -= op.d.length;
      else if (op.p < caret) caret = op.p;
    }
    if (typeof op.i === "string") {
      // Text inserted exactly at the caret belongs behind it, so someone
      // typing where you are does not push your cursor along.
      if (op.p < caret) caret += op.i.length;
    }
  }
  return caret;
}
