/**
 * What a live document's local copy holds relative to its OtDocument, and the
 * texts that follow from it: the checkpoint a leave hands regular sync, and
 * the text a rejoin carries the local copy forward from.
 */
import { applyOps, invertOps, type OtDocument, type OtOp } from "./ot";
import { replayInto, type JoinedDoc, type ReplayedUpdate } from "./overleaf-realtime-model";

/** A text Overleaf's copy of a document grew from, and the version it held then or after. */
export type Checkpoint = { text: string; version: number };

/**
 * What the local copy of a live document — the editor buffer and the file on
 * disk — holds relative to its OtDocument, and so which text the leave
 * checkpoint hands regular sync as both sides' ancestor, and which one a
 * later rejoin carries the local copy forward from.
 *
 * `OtDocument.serverText` is that ancestor whenever every operation applied to
 * the document also reached the local copy, which is the usual case. It is
 * not when an operation arrives while the document drains off screen, or
 * while its delivery to the editor is still crossing IPC as the writer moves
 * on: the server's text then has text the disk lacks, and a sync merging from
 * it would read that text as deleted here and delete it from Overleaf too.
 * So the operations the local copy has not taken are kept, and the local
 * copy's text is the document's with them undone. Once everything typed here
 * is acknowledged, that text is on Overleaf too, under those operations.
 */
export class DocumentProof {
  /** Operations applied to the document that the local copy has not taken, a batch per update, oldest first. */
  private behind: OtOp[][] = [];
  /** Whether the local copy is known to hold the document's text with `behind` undone, plus typing not sent yet. */
  private known = false;
  /** An operation went out outside OtDocument (a reject's inverse): nothing here is trusted again. */
  private broken = false;
  /** The last checkpoint proven before the current state stopped proving one. */
  private earlier: Checkpoint | null = null;
  /** The checkpoint the last leave wrote, kept while the document is parked; see `DocumentProofs`. */
  leftWith: string | null = null;

  constructor(public receipt: string) {}

  /** `doc.remote`, keeping track of what the local copy has not taken yet. */
  remote(doc: OtDocument, ops: OtOp[], version: number) {
    this.remember(doc);
    const result = doc.remote(ops, version);
    if (result.applied.length) this.behind.push(result.applied);
    return result;
  }

  /** `replayInto`, keeping track of what the local copy has not taken yet. */
  replay(doc: OtDocument, updates: ReplayedUpdate[], publicId: string | null, stopAfterOurs = false) {
    this.remember(doc);
    const result = replayInto(doc, updates, publicId, stopAfterOurs);
    if (result.applied.length) this.behind.push(result.applied);
    return result;
  }

  /** `doc.local` with the local copy's text, which the document then holds exactly. */
  typed(doc: OtDocument, text: string) {
    this.remember(doc);
    const result = doc.local(text);
    if (!this.broken) {
      this.behind = [];
      this.known = true;
    }
    return result;
  }

  /** Taken when a delivery to the local copy is queued: everything applied up to now is in it. */
  deliveryMark(): OtOp[] | null {
    return this.behind.at(-1) ?? null;
  }

  /** The local copy took a delivery queued at `mark` (the text plus, at most, typing of its own). */
  delivered(mark: OtOp[] | null) {
    if (this.broken) return;
    this.behind = this.behind.slice(mark ? this.behind.indexOf(mark) + 1 : 0);
    this.known = true;
  }

  /** The local copy may or may not have taken a delivery: what it holds is unknown until the next one lands. */
  lost(doc: OtDocument) {
    this.remember(doc);
    this.known = false;
  }

  /** An operation went out outside the document: it no longer describes Overleaf's text, for good. */
  invalidate(doc: OtDocument) {
    this.lost(doc);
    this.broken = true;
  }

  /**
   * The local copy's text with no typing of its own, and the operations that
   * took it to the document's text; null when that is not known.
   */
  localCopy(doc: OtDocument): { text: string; ops: OtOp[] } | null {
    if (!this.known) return null;
    const ops = this.behind.flat();
    const text = ops.length ? applyOps(doc.text, invertOps(ops)) : doc.text;
    return text === null ? null : { text, ops };
  }

  /**
   * The newest text both the local copy and Overleaf grew from: what the
   * leave checkpoint writes. While the local copy has taken everything
   * applied, that is `serverText` (typing still owed to the server is the
   * local copy's own work on top of it). Otherwise it is the local copy's
   * text once everything typed in it is acknowledged, and until then
   * whichever text was proven last.
   */
  checkpoint(doc: OtDocument): Checkpoint | null {
    return this.proven(doc) ?? this.earlier;
  }

  private proven(doc: OtDocument): Checkpoint | null {
    if (!this.known) return null;
    if (!this.behind.length) return { text: doc.serverText, version: doc.version };
    const text = doc.settled ? this.localCopy(doc)?.text : undefined;
    return text === undefined ? null : { text, version: doc.version };
  }

  private remember(doc: OtDocument) {
    this.earlier = this.proven(doc) ?? this.earlier;
  }
}

/**
 * Every document's proof, and the documents parked when they were let go of
 * settled with the local copy's text as their checkpoint. Coming back to a
 * parked document, the server replays what happened since from its version,
 * and the local copy is carried forward by exactly those operations instead
 * of being handed to regular sync.
 */
export class DocumentProofs {
  private proofs = new WeakMap<OtDocument, DocumentProof>();
  private parked = new Map<string, OtDocument>();

  /** Every document changes through its proof, so what the local copy holds stays known. */
  of(doc: OtDocument): DocumentProof {
    let proof = this.proofs.get(doc);
    if (!proof) this.proofs.set(doc, proof = new DocumentProof(""));
    return proof;
  }

  /** A fresh proof for a document started over from the server's copy. */
  start(doc: OtDocument, receipt: string) {
    this.proofs.set(doc, new DocumentProof(receipt));
  }

  /**
   * Park `doc`, let go of with `checkpoint` written: only when that is exactly
   * the local copy's text, as the replay a rejoin asks for starts from the
   * document's version, which that text and the operations after it describe.
   */
  park(id: string, doc: OtDocument, checkpoint: Checkpoint | null) {
    const proof = this.of(doc);
    if (!checkpoint || !doc.settled || proof.localCopy(doc)?.text !== checkpoint.text) return;
    proof.leftWith = checkpoint.text;
    this.parked.set(id, doc);
  }

  /** The version to resume `id` from, when it is parked. */
  parkedAt(id: string): number | undefined {
    return this.parked.get(id)?.version;
  }

  /** Forget the parked `id`, or every parked document. */
  unpark(id?: string) {
    if (id === undefined) this.parked.clear();
    else this.parked.delete(id);
  }

  /**
   * Take the parked `id` back up from a join's replay, when that is provably
   * sound: no sync has moved the checkpoint it left with (a sync's merge
   * makes the disk something its operations do not describe), and the replay
   * leaves it exactly where Overleaf says it is. Null for anything less — a
   * version the server cannot reach back to, an update missing from the
   * replay — and a full join, which trusts only the agreed text, starts over.
   */
  resume(id: string, joined: JoinedDoc, publicId: string | null, receipt: string): OtDocument | null {
    const doc = this.parked.get(id);
    this.parked.delete(id);
    if (!doc) return null;
    const proof = this.of(doc);
    if (!joined.resumed || joined.agreed !== proof.leftWith) return null;
    try {
      proof.replay(doc, joined.caughtUp ?? [], publicId);
    } catch {
      return null;
    }
    if (doc.version !== joined.version || doc.serverText !== joined.text) return null;
    proof.receipt = receipt;
    proof.leftWith = null;
    return doc;
  }
}

/**
 * Where a joined document's `text` reaches the local copy from.
 *
 * A document resumed from a replay carries the local copy forward by exactly
 * the operations it has not taken (`local`): the replay's, and any that
 * arrived while it drained off screen. Typing of its own, an agent's edit
 * say, rides on top where the server would place it.
 *
 * A full snapshot is merged with the buffer only from a held document's
 * local copy, settled (`heldShared`): proven in this session to be text both
 * sides grew from, so the writer's work since is carried onto Overleaf's the
 * way OT would place it and goes out as operations. The last sync's agreed
 * text proves no such thing (an edit can have reached both sides since, and
 * a merge from it would add that edit twice), so it only says when one side
 * alone moved on: a buffer still holding it takes Overleaf's text, and while
 * Overleaf still holds it the buffer's own work goes out as operations.
 * Anything else has no trusted relationship to local disk edits and is left
 * to regular sync.
 */
export function joinDelivery(text: string, { replacedText, local, heldShared, agreed }: {
  /** A copy a reject left stale, which the text lands over. */
  replacedText: string | null;
  local: { text: string; ops: OtOp[] } | null;
  heldShared: string | null;
  agreed: string | null;
}): { base: string; ops?: OtOp[]; carryTyping?: boolean } {
  if (replacedText !== null) return { base: replacedText };
  if (local) return { base: local.text, ops: local.ops, carryTyping: true };
  if (heldShared !== null) return { base: heldShared, carryTyping: true };
  if (agreed !== null && agreed !== text) return { base: agreed };
  return { base: text, carryTyping: agreed === text };
}
