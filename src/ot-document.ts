/**
 * Client state for one document edited live through Overleaf.
 *
 * The server applies operations in a single order and is the authority. A
 * client can only have one operation in flight at a time, so anything typed
 * while waiting is collected and sent as one operation on acknowledgement.
 * Everything arriving from the server has to be transformed against whatever
 * this client still owes, and vice versa — that bookkeeping is the whole job
 * here, and getting it wrong is how characters go missing.
 *
 * This mirrors the ShareJS client Overleaf's own editor uses.
 */
import { applyOps, diffToOps, transformCaret, type OtOp } from "./ot-ops";
import { composeOps, transformBoth } from "./ot-transform";

export type OtSendResult = {
  /** Ops to put on the wire now, or null when one is already in flight. */
  send: { version: number; ops: OtOp[] } | null;
};

export type OtRemoteResult = {
  /** The document after the remote work landed. */
  text: string;
  /** The ops that were actually applied locally, for moving the caret. */
  applied: OtOp[];
};

/**
 * Thrown when the server's view and ours have provably diverged. Recovering
 * means re-fetching the document rather than guessing, so this is deliberately
 * loud instead of silently producing wrong text.
 */
export class OtDesyncError extends Error {}

export class OtDocument {
  /** The text this client believes is current, including unsent work. */
  text: string;
  /** The last server version we have seen. */
  version: number;
  /** Sent, not yet acknowledged. */
  private inflight: OtOp[] | null = null;
  /** Typed while `inflight` was outstanding. */
  private pending: OtOp[] | null = null;

  constructor(text: string, version: number) {
    this.text = text;
    this.version = version;
  }

  /** True while the server still owes us an acknowledgement. */
  get waiting(): boolean {
    return this.inflight !== null;
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
  local(nextText: string): OtSendResult {
    const ops = diffToOps(this.text, nextText);
    this.text = nextText;
    if (ops.length === 0) return { send: null };

    if (this.inflight) {
      this.pending = this.pending ? composeOps(this.pending, ops) : ops;
      return { send: null };
    }
    this.inflight = ops;
    return { send: { version: this.version, ops } };
  }

  /**
   * Reserve the wire for an operation that carries no text — a comment anchor.
   *
   * Returns the version to send it at, or null when something is already in
   * flight: the server numbers versions, so two operations cannot be built on
   * the same one. Recording it as in flight is what makes the acknowledgement
   * move the version on, and what makes anything typed meanwhile wait its turn.
   */
  anchor(): { version: number } | null {
    if (this.inflight) return null;
    this.inflight = [];
    return { version: this.version };
  }

  /**
   * The server accepted our in-flight operation. Anything typed since goes out
   * now, as a single operation.
   *
   * `version` is the version the operation applied at, as the server reports
   * it. An older one is a duplicate acknowledgement and is ignored; a newer
   * one means the server and this document disagree about history, which
   * cannot be recovered from by guessing.
   */
  acknowledge(version?: number): OtSendResult {
    if (version != null && version < this.version) return { send: null };
    if (version != null && version !== this.version) {
      throw new OtDesyncError(
        `Overleaf acknowledged version ${version} while this document is at ${this.version}.`,
      );
    }
    if (!this.inflight) return { send: null };
    this.inflight = null;
    this.version += 1;
    if (!this.pending) return { send: null };
    this.inflight = this.pending;
    this.pending = null;
    return { send: { version: this.version, ops: this.inflight } };
  }

  /**
   * Apply work from someone else. Our outstanding operations are rewritten to
   * account for it, and it is rewritten to account for them, so both sides end
   * up at the same text no matter which order things arrived in.
   */
  remote(ops: OtOp[], version: number): OtRemoteResult {
    let incoming = ops;
    // Order matters: the incoming operation is already in the server's history,
    // so it takes precedence, and ours is transformed as the later one. The
    // server will transform our operation the same way when it arrives — if
    // the two disagreed, two people inserting at the same spot would order the
    // text differently here than on the server and never converge.
    if (this.inflight) {
      const [theirs, ours] = transformBoth(incoming, this.inflight);
      this.inflight = ours;
      incoming = theirs;
    }
    if (this.pending) {
      const [theirs, ours] = transformBoth(incoming, this.pending);
      this.pending = ours;
      incoming = theirs;
    }
    const next = applyOps(this.text, incoming);
    if (next === null) {
      throw new OtDesyncError(
        "An update from Overleaf did not fit this document; it needs to be reloaded.",
      );
    }
    this.text = next;
    this.version = version;
    return { text: next, applied: incoming };
  }

  /** Where a caret sitting at `offset` belongs after `applied` landed. */
  static caretAfter(offset: number, applied: OtOp[]): number {
    return transformCaret(offset, applied);
  }

  /**
   * Start again from the server's copy, dropping unsent work.
   *
   * Used after a desync or a reconnect: guessing at reconciliation risks
   * writing something neither side wrote, so the server's copy wins.
   */
  reset(text: string, version: number) {
    this.text = text;
    this.version = version;
    this.inflight = null;
    this.pending = null;
  }
}
