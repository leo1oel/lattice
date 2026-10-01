/**
 * Operational transformation for Overleaf's text operations, and the client
 * state for one document edited live through it.
 *
 * Overleaf's realtime protocol does not exchange whole documents — it
 * exchanges positioned inserts and deletes, which is what lets two people type
 * in one paragraph without either version being overwritten. When both edit
 * at once, each side's operation was written against a document the other has
 * already changed; transformation rewrites one so it still means the same
 * thing after the other landed. The semantics match ShareJS's `text` type,
 * which Overleaf's server applies, and the property everything rests on is
 * convergence: a-then-transformed-b equals b-then-transformed-a
 * (`ot.test.ts` checks it on thousands of random operations).
 */

import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

/** One OT operation: insert `i` or delete `d`, both at character offset `p`. */
export type OtOp = { p: number; i?: string; d?: string };

/**
 * Describe the change from `before` to `after` as ops.
 *
 * Editing is overwhelmingly one contiguous change at a time — typing, pasting,
 * deleting a selection — so this narrows to the differing middle by matching
 * the common prefix and suffix. That produces exactly the ops the web editor
 * would send for the same keystroke, and never invents overlapping edits.
 */
export function diffToOps(before: string, after: string): OtOp[] {
  if (before === after) return [];
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  // Never cut a character in half. Two emoji can share the first half of
  // their UTF-16 pair, and an op holding only the second half is a lone
  // surrogate that Overleaf turns into U+FFFD — corrupting a character the
  // edit never meant to touch.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;
  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  // Delete first: the insert's position is then expressed against the text
  // that remains, which is what the server expects.
  return [
    ...(removed ? [{ p: prefix, d: removed }] : []),
    ...(inserted ? [{ p: prefix, i: inserted }] : []),
  ];
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const SURROGATE = /[\uD800-\uDFFF]/;
const SURROGATES = new RegExp(SURROGATE.source, "g");

/**
 * What Overleaf actually stores for these ops.
 *
 * Its document updater replaces every UTF-16 surrogate in inserted text with
 * U+FFFD — both halves of an emoji or a `unicode-math` letter like 𝔸, one
 * replacement character each — and still acknowledges the operation as sent.
 * Sending such text unchanged leaves this side holding characters the server
 * does not have, with nothing to say so until a later sync quietly replaces
 * them. Mirroring the server keeps the two copies identical, and lengths (so
 * every position) stay the same.
 */
export function asOverleafStores(ops: OtOp[]): { ops: OtOp[]; replaced: boolean } {
  let replaced = false;
  const stored = ops.map((op) => {
    if (typeof op.i !== "string" || !SURROGATE.test(op.i)) return op;
    replaced = true;
    return { ...op, i: op.i.replace(SURROGATES, "\uFFFD") };
  });
  return { ops: stored, replaced };
}

/**
 * Apply ops to a document, in order, so the local copy ends up byte-identical
 * to the server's. Null when an op does not fit the text (a delete whose
 * content differs, a position past the end) — a sign the local copy drifted,
 * which the caller recovers from by re-fetching rather than writing it to disk.
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
 * Where a caret at `offset` belongs after `ops` landed. Without this an edit
 * above the cursor drags it, and the person typing loses their spot.
 */
export function transformCaret(offset: number, ops: OtOp[]): number {
  let caret = offset;
  for (const op of ops) {
    if (typeof op.d === "string") {
      if (op.p + op.d.length <= caret) caret -= op.d.length;
      else if (op.p < caret) caret = op.p;
    }
    // Text inserted exactly at the caret belongs behind it, so someone
    // typing where you are does not push your cursor along.
    if (typeof op.i === "string" && op.p < caret) caret += op.i.length;
  }
  return caret;
}

/**
 * Where a span — a comment quote, a suggestion — ends up after `ops`.
 *
 * Overleaf states where these sit once, when a document is joined, and then
 * expects them to ride along on the operations that move the text. Text typed
 * at either edge lands outside the span: accepting a suggestion rewrites what
 * the span covers, so one that swallowed the words next to it would change
 * text nobody proposed changing. A span whose text is deleted outright
 * collapses to length 0.
 */
export function transformSpan(span: { from: number; length: number }, ops: OtOp[]): { from: number; length: number } {
  let { from, length } = span;
  for (const op of ops) {
    if (typeof op.i === "string") {
      if (op.p <= from) from += op.i.length;
      else if (op.p < from + length) length += op.i.length;
    } else if (typeof op.d === "string") {
      const start = op.p;
      const end = op.p + op.d.length;
      if (end <= from) from -= op.d.length;
      else if (start < from + length) {
        // Overlapping: lose the deleted part of the span, and move its start
        // back by however much of the deletion was in front of it.
        length -= Math.min(end, from + length) - Math.max(start, from);
        if (start < from) from = start;
      }
    }
  }
  return { from, length };
}

/**
 * Add a component, merging it into the previous one when they are adjacent.
 * Merging keeps operations in the canonical shape the server produces, so a
 * round trip does not reshuffle a document's history.
 */
function append(op: OtOp[], component: OtOp): void {
  if (component.i === "" || component.d === "") return;
  const last = op[op.length - 1];
  const inject = (source: string, position: number, text: string) => source.slice(0, position) + text + source.slice(position);
  if (last?.i != null && component.i != null && last.p <= component.p && component.p <= last.p + last.i.length) {
    op[op.length - 1] = { p: last.p, i: inject(last.i, component.p - last.p, component.i) };
  } else if (last?.d != null && component.d != null && component.p <= last.p && last.p <= component.p + component.d.length) {
    op[op.length - 1] = { p: component.p, d: inject(component.d, last.p - component.p, last.d) };
  } else {
    op.push(component);
  }
}

/**
 * Where a position ends up after `component`. `insertAfter` breaks the tie
 * when an insert lands exactly on it: the two sides must disagree
 * consistently, or concurrent inserts at one spot would never converge.
 */
function transformPosition(position: number, component: OtOp, insertAfter: boolean): number {
  if (component.i != null) {
    return component.p < position || (component.p === position && insertAfter) ? position + component.i.length : position;
  }
  const deleted = component.d ?? "";
  if (position <= component.p) return position;
  if (position <= component.p + deleted.length) return component.p;
  return position - deleted.length;
}

/** Transform one component against one other, appending the result. */
function transformComponent(destination: OtOp[], component: OtOp, other: OtOp, side: "left" | "right"): void {
  if (component.i != null) {
    append(destination, { p: transformPosition(component.p, other, side === "right"), i: component.i });
    return;
  }
  const deleted = component.d ?? "";
  if (other.i != null) {
    // Our delete spans text the other side just split with an insert, so it
    // becomes two deletes — one each side of the inserted text, which is left
    // untouched because we never meant to remove it.
    const split = Math.max(0, other.p - component.p);
    if (component.p < other.p) append(destination, { p: component.p, d: deleted.slice(0, split) });
    if (deleted.slice(split) !== "") append(destination, { p: component.p + other.i.length, d: deleted.slice(split) });
    return;
  }
  const otherDeleted = other.d ?? "";
  if (component.p >= other.p + otherDeleted.length) {
    // Entirely after their delete: shift back by what they removed.
    append(destination, { p: component.p - otherDeleted.length, d: deleted });
  } else if (component.p + deleted.length <= other.p) {
    // Entirely before their delete: unaffected.
    append(destination, component);
  } else {
    // The two deletes overlap. Whatever they already removed is gone, so only
    // the parts outside their range remain for us to delete.
    let remaining = component.p < other.p ? deleted.slice(0, other.p - component.p) : "";
    if (component.p + deleted.length > other.p + otherDeleted.length) {
      remaining += deleted.slice(other.p + otherDeleted.length - component.p);
    }
    if (remaining !== "") append(destination, { p: transformPosition(component.p, other, false), d: remaining });
  }
}

/**
 * Transform two concurrent operations against each other, returning each
 * rewritten to apply after the other. The first takes precedence in ties.
 *
 * Doing both together is what makes multi-component operations correct: as
 * each of the left op's components is transformed, the right component has to
 * be carried forward transformed too, or every later position is measured
 * against a document that no longer exists. A component can also split in two
 * (a delete straddling an insert), and then the rest of the work has to be
 * transformed against both halves — hence the recursion.
 */
export function transformBoth(left: OtOp[], right: OtOp[]): [OtOp[], OtOp[]] {
  let leftOp = left;
  const newRightOp: OtOp[] = [];
  for (const original of right) {
    let rightComponent: OtOp | null = original;
    const newLeftOp: OtOp[] = [];
    for (let index = 0; index < leftOp.length && rightComponent; index += 1) {
      const split: OtOp[] = [];
      transformComponent(newLeftOp, leftOp[index]!, rightComponent, "left");
      transformComponent(split, rightComponent, leftOp[index]!, "right");
      if (split.length === 1) {
        rightComponent = split[0]!;
      } else if (split.length === 0) {
        // The right component vanished (fully deleted by the left op), so the
        // rest of the left op is unaffected by it.
        for (const rest of leftOp.slice(index + 1)) append(newLeftOp, rest);
        rightComponent = null;
      } else {
        const [restLeft, restRight] = transformBoth(leftOp.slice(index + 1), split);
        for (const item of restLeft) append(newLeftOp, item);
        for (const item of restRight) append(newRightOp, item);
        rightComponent = null;
      }
    }
    if (rightComponent) append(newRightOp, rightComponent);
    leftOp = newLeftOp;
  }
  return [leftOp, newRightOp];
}

/** Combine two operations that apply one after the other into a single one. */
export function composeOps(first: OtOp[], second: OtOp[]): OtOp[] {
  const result = first.slice();
  for (const component of second) append(result, component);
  return result;
}

type OtSend = { version: number; ops: OtOp[] } | null;

/**
 * Thrown when the server's view and ours have provably diverged. Recovering
 * means re-fetching the document rather than guessing, so this is deliberately
 * loud instead of silently producing wrong text.
 */
export class OtDesyncError extends Error {}

/**
 * Client state for one document edited live through Overleaf, mirroring the
 * ShareJS client Overleaf's own editor uses.
 *
 * The server applies operations in a single order and is the authority. A
 * client can only have one operation in flight at a time, so anything typed
 * while waiting is collected and sent as one operation on acknowledgement.
 * Everything arriving from the server has to be transformed against whatever
 * this client still owes, and vice versa — that bookkeeping is the whole job
 * here, and getting it wrong is how characters go missing.
 *
 * Every `version` a method takes is the version an operation applied at, as
 * Overleaf reports it; the document then moves to `version + 1`. An older one
 * is the same operation arriving twice and is ignored; a newer one means an
 * operation went missing, which cannot be repaired by guessing.
 */
export class OtDocument {
  /** Sent, not yet acknowledged. */
  private inflight: OtOp[] | null = null;
  /** Typed while `inflight` was outstanding. */
  private pending: OtOp[] | null = null;
  /**
   * Every connection `inflight` has gone out on. Overleaf names a new
   * connection id each time the socket reconnects and stamps it on the update
   * as its source, so after a reconnect the replay of an operation we sent
   * earlier carries an id that is no longer ours — and only this list can
   * still recognise it as our own acknowledgement.
   */
  private submitted: string[] = [];

  /** `text` includes unsent work; `version` is the last server version seen. */
  constructor(public text: string, public version: number) {}

  /** True while the server still owes us an acknowledgement. */
  get waiting(): boolean {
    return this.inflight !== null;
  }

  /** The connections the operation in flight has been sent on, oldest first. */
  get submittedVia(): readonly string[] {
    return this.submitted;
  }

  /** Record that the operation in flight went out on connection `publicId`. */
  noteSubmitted(publicId: string) {
    if (this.inflight && !this.submitted.includes(publicId)) this.submitted.push(publicId);
  }

  /**
   * The operation in flight again, to resend after a reconnect. Only valid
   * once a replay has brought `version` up to date, which also transformed
   * the operation to match; null when there is no text to send.
   */
  resend(): OtSend {
    return this.inflight?.length ? { version: this.version, ops: this.inflight } : null;
  }

  /**
   * The text the server will hold once the operation in flight lands exactly
   * as sent, which is what Overleaf's update `hash` describes. Null when
   * nothing is in flight, or when later work is queued on top of it and this
   * copy is already ahead of that.
   */
  get sentText(): string | null {
    return this.inflight && !this.pending ? this.text : null;
  }

  /** True when everything typed here has reached the server. */
  get settled(): boolean {
    return this.inflight === null && this.pending === null;
  }

  /**
   * Record a local edit. Returns what to send, if anything: while an operation
   * is in flight the new work waits, because the server numbers versions and
   * would reject a second operation built on a version it has not confirmed.
   */
  local(nextText: string): { send: OtSend; replaced: boolean } {
    const typed = diffToOps(this.text, nextText);
    // See `asOverleafStores`: when it changes what was typed, `text` takes
    // the stored form and the caller has to show it in place of the original.
    const { ops, replaced } = asOverleafStores(typed);
    this.text = replaced ? applyOps(this.text, ops) ?? nextText : nextText;
    if (ops.length === 0) return { send: null, replaced };
    if (this.inflight) {
      this.pending = this.pending ? composeOps(this.pending, ops) : ops;
      return { send: null, replaced };
    }
    this.inflight = ops;
    return { send: { version: this.version, ops }, replaced };
  }

  /**
   * Reserve the wire for an operation that carries no text — a comment anchor.
   * Null when something is already in flight. Recording it as in flight is
   * what makes the acknowledgement move the version on, and what makes
   * anything typed meanwhile wait its turn.
   */
  anchor(): { version: number } | null {
    if (this.inflight) return null;
    this.inflight = [];
    return { version: this.version };
  }

  /** The server accepted our in-flight operation. Anything typed since goes out now, as a single operation. */
  acknowledge(version?: number): { send: OtSend } {
    if (version != null && version < this.version) return { send: null };
    if (version != null && version !== this.version) {
      const current = this.version;
      throw new OtDesyncError(i18n._(msg`Overleaf acknowledged version ${version} while this document is at ${current}.`));
    }
    if (!this.inflight) return { send: null };
    this.inflight = null;
    this.submitted = [];
    this.version += 1;
    if (!this.pending) return { send: null };
    // Work typed while waiting can cancel out entirely against someone else's
    // edit — both deleted the same words. There is then nothing to send, and
    // sending an empty operation anyway is worse than useless: nothing goes
    // on the wire, so no acknowledgement ever comes, and every later edit
    // queues behind it forever. Overleaf's own client drops it the same way.
    if (this.pending.length === 0) {
      this.pending = null;
      return { send: null };
    }
    this.inflight = this.pending;
    this.pending = null;
    return { send: { version: this.version, ops: this.inflight } };
  }

  /**
   * Apply work from someone else. Our outstanding operations are rewritten to
   * account for it, and it for them, so both sides end up at the same text no
   * matter which order things arrived in. Returns the ops actually applied
   * locally, for moving the caret and anchors.
   *
   * Storing `version` flat instead of `version + 1` leaves us a version behind
   * and nothing complains — the server quietly transforms our next operation
   * forward a second time and lands it at the wrong offset for everyone else.
   */
  remote(ops: OtOp[], version: number): { text: string; applied: OtOp[] } {
    if (version < this.version) return { text: this.text, applied: [] };
    if (version !== this.version) {
      const current = this.version;
      throw new OtDesyncError(i18n._(msg`Overleaf sent version ${version} while this document is at ${current}.`));
    }
    // The incoming operation is already in the server's history, so it takes
    // precedence and ours is transformed as the later one — exactly as the
    // server will when ours arrives, or two inserts at one spot would order
    // differently here and never converge.
    let incoming = ops;
    if (this.inflight) [incoming, this.inflight] = transformBoth(incoming, this.inflight);
    if (this.pending) {
      [incoming, this.pending] = transformBoth(incoming, this.pending);
      // Cancelled out entirely (see `acknowledge`): nothing is left to send.
      if (this.pending.length === 0) this.pending = null;
    }
    const next = applyOps(this.text, incoming);
    if (next === null) throw new OtDesyncError(i18n._(msg`An update from Overleaf did not fit this document; it needs to be reloaded.`));
    this.text = next;
    this.version = version + 1;
    return { text: next, applied: incoming };
  }

  /**
   * Replay the work the server did while this document was not being watched.
   *
   * Coming back to a file, the alternative is taking the server's text as it
   * stands, which silently throws away anything typed here that never got
   * that far. Each update is either someone else's, which our outstanding work
   * is transformed against, or our own finally landing, which is an
   * acknowledgement in every respect. `send` is whatever became sendable.
   */
  catchUp(updates: { version: number; ops: OtOp[]; mine: boolean }[]): { text: string; applied: OtOp[]; send: OtSend } {
    // Each applied list is in the coordinate space left by the ones before it,
    // so they concatenate for the purpose of moving a caret.
    const applied: OtOp[] = [];
    let send: OtSend = null;
    for (const update of updates) {
      if (update.mine) send = this.acknowledge(update.version).send ?? send;
      else applied.push(...this.remote(update.ops, update.version).applied);
    }
    return { text: this.text, applied, send };
  }

  /** Start again from the server's copy, dropping unsent work: guessing at reconciliation risks writing text neither side wrote. */
  reset(text: string, version: number) {
    this.text = text;
    this.version = version;
    this.inflight = null;
    this.pending = null;
    this.submitted = [];
  }
}
