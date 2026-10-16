/**
 * What the live-editing channel sends and answers, and the pure rules
 * `useOverleafRealtime` applies to it: carrying anchors across operations,
 * proving what the disk copy shares with Overleaf, and deciding whether a
 * failed connection is worth retrying. The hook owns every piece of state;
 * nothing here does.
 */
import { mentionsAny } from "../platform/ipc-error-phrases";
import { transformSpan, type OtDocument, type OtOp } from "./ot";

export type DocEntry = { id: string; path: string };
/** One entity in the project, with the id Overleaf's own endpoints take. */
export type EntityEntry = { id: string; path: string; kind: "doc" | "file" | "folder" };
/** What this account may do to the project, as Overleaf reports it. */
export type OverleafPermission = "owner" | "readAndWrite" | "review" | "readOnly" | "unknown";
export type JoinedProject = { publicId: string | null; docs: DocEntry[]; entities: EntityEntry[]; permission: OverleafPermission };
/** Where a comment thread is anchored in the open document. */
export type CommentRange = { threadId: string; position: number; quote: string };
export type OverleafCommentTarget = { projectRoot: string; docId: string; path: string };
/** A suggestion in the open document: text somebody proposed adding or removing. */
export type TrackedChange = {
  id: string;
  position: number;
  text: string;
  /** True when `text` was removed as a suggestion and is absent from the document. */
  deletion: boolean;
  userId: string | null;
  timestamp: string | null;
  /** The author's colour in Overleaf's own palette. */
  hue: number;
};
/** The exact document/version pair reserved for an out-of-band OT mutation. */
export type ReservedOperation = { docId: string; version: number };

/** A replayed update: applied at `version`, and our own work comes back here as an ack. */
export type ReplayedUpdate = { version: number; ops: OtOp[]; source: string | null };
export type JoinedDoc = {
  text: string;
  version: number;
  comments: CommentRange[];
  changes: TrackedChange[];
  /** Updates replayed by a join that resumed from a version we already had. */
  caughtUp: ReplayedUpdate[];
  /** Whether the server honoured the version we asked to resume from; if not, `text` is all there is. */
  resumed: boolean;
};

export type DocUpdateEvent = { type: "docUpdate"; docId: string } & ReplayedUpdate;
export type OverleafRemoteTextContext = {
  projectRoot: string;
  path: string;
  baseContent: string;
  isCurrent: () => boolean;
};

/** The document on screen, with the spans Overleaf anchored in it. */
export type OpenDoc = { id: string; comments: CommentRange[]; changes: TrackedChange[] };
export type RealtimeStatus = "off" | "connecting" | "live" | "error";

/**
 * Whether an update came from the connection Overleaf named `publicId` — never
 * before it has named one — or from an earlier connection that `submittedVia`
 * says carried the operation still waiting for its answer.
 */
export const isOwnUpdate = (source: string | null, publicId: string | null, submittedVia: readonly string[] = []) =>
  Boolean(source) && (source === publicId || submittedVia.includes(source!));

/**
 * Overleaf refused a request while the session is still valid
 * (SESSION_STILL_VALID in overleaf_rt.rs): often brief, but a lost share
 * persists, so it is retried only this many times before being reported.
 */
export const OVERLEAF_REFUSAL_RETRIES = 3;
/* eslint-disable lingui/no-unlocalized-strings -- phrases matched in backend error text */
export const OVERLEAF_SESSION_STILL_VALID = "session is still valid";
/** overleaf_rt.rs's SESSION_EXPIRED and NOT_CONNECTED. */
export const OVERLEAF_SESSION_EXPIRED = "Overleaf session expired";
export const OVERLEAF_NOT_CONNECTED = "Not connected to Overleaf";
/** ipc.rs's stale-project refusal, link.rs's unlinked project and the realtime channel's replacement. */
export const PROJECT_CHANGED = "project changed";
export const PROJECT_NOT_LINKED = "not linked";
export const NEWER_OVERLEAF_CONNECTION = "newer Overleaf connection";
/* eslint-enable lingui/no-unlocalized-strings */
export const isOverleafProjectRefusal = (reason: string) => mentionsAny(reason, [OVERLEAF_SESSION_STILL_VALID]);

/** Authentication and project-identity failures need user action, not a retry loop. */
export function shouldRetryConnection(reason: string): boolean {
  // The regex's words also catch what Overleaf's servers and the realtime
  // handshake say in their own words, so no Rust source pins them.
  return !mentionsAny(reason, [OVERLEAF_NOT_CONNECTED, PROJECT_CHANGED, PROJECT_NOT_LINKED, NEWER_OVERLEAF_CONNECTION])
    && !/session expired|cookie|sign.?in|authentication|unauthorized|forbidden|permission|invalid project/i.test(reason);
}

/**
 * What a document's disk copy provably shares with Overleaf. OT's text may
 * include a peer update the editor or disk rejected, so settled OT alone is
 * not proof of a locally materialized common ancestor; the leave checkpoint
 * handed back to sync is `lastShared`, promoted only when both agree.
 */
export type DocumentProof = {
  receipt: string;
  lastShared: { text: string; version: number } | null;
  locallyAppliedText: string | null;
  /** False once an operation was sent outside OtDocument, until a full reset. */
  textModelValid: boolean;
};

export function promoteShared(doc: OtDocument, proof: DocumentProof | undefined) {
  if (proof?.textModelValid && doc.settled && doc.text === proof.locallyAppliedText) {
    proof.lastShared = { text: doc.text, version: doc.version };
  }
}

/**
 * Carry the open document's anchored spans across an operation.
 *
 * Overleaf states where comments and suggestions sit when the document is
 * joined and never mentions them again — they are expected to ride along on
 * the operations that move the text. Without this they drift, and a drifted
 * suggestion is worse than a misplaced highlight: accepting or rejecting one
 * applies to a range, so it would rewrite text nobody proposed touching.
 * Applies to our own typing as much as to anyone else's.
 */
export function anchorsAfter(current: OpenDoc, ops: OtOp[]): Pick<OpenDoc, "comments" | "changes"> {
  return {
    comments: current.comments.map((comment) => {
      const from = transformSpan({ from: comment.position, length: comment.quote.length }, ops).from;
      return from === comment.position ? comment : { ...comment, position: from };
    }),
    // A suggestion whose text was deleted outright has nothing left to accept
    // or reject; dropping it is better than offering a button that would act
    // on whatever moved into its place.
    changes: current.changes.flatMap((change) => {
      const moved = transformSpan({ from: change.position, length: change.text.length }, ops);
      if (moved.length <= 0) return [];
      return [moved.from === change.position ? change : { ...change, position: moved.from }];
    }),
  };
}

/**
 * The `hash` Overleaf checks an update against: SHA-1 of
 * `blob {length}\0{text}`, a git blob hash with the length counted in UTF-16
 * units the way JavaScript counts it and the text as UTF-8 — exactly what its
 * document updater computes for the text the update produces.
 */
export async function overleafDocHash(text: string): Promise<string> {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- digest algorithm and the hashed wire format
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`blob ${text.length}\0${text}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
