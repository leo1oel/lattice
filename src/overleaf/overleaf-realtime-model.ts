/**
 * What the live-editing channel sends and answers, and the pure rules
 * `useOverleafRealtime` applies to it: carrying anchors across operations,
 * proving what the disk copy shares with Overleaf, and deciding whether a
 * failed connection is worth retrying. The hook owns every piece of state;
 * nothing here does.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { hostErrorText } from "../platform/host-error-text";
import { mentionsAny } from "../platform/ipc-error-phrases";
import { transformSpan, type OtDocument, type OtOp } from "./ot";
import type { OverleafConnectionStore } from "./overleaf-connection-store";
import { changesAfter, type Suggester } from "./overleaf-suggestions";

export type DocEntry = { id: string; path: string };
/** One entity in the project, with the id Overleaf's own endpoints take. */
export type EntityEntry = { id: string; path: string; kind: "doc" | "file" | "folder" };
/** What this account may do to the project, as Overleaf reports it. */
export type OverleafPermission = "owner" | "readAndWrite" | "review" | "readOnly" | "unknown";
export type JoinedProject = {
  publicId: string | null; docs: DocEntry[]; entities: EntityEntry[]; permission: OverleafPermission;
  /** Overleaf's track-changes setting for this account: whether our edits go out as suggestions. */
  trackChanges?: boolean;
  /** Our account, and the colour our suggestions are drawn in. */
  userId?: string | null; ownHue?: number;
};
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
  /** The text the last sync agreed this document held, when that is still on record. */
  agreed?: string | null;
};

/** `suggestedBy` is set when the update was sent as a suggestion. */
export type DocUpdateEvent = { type: "docUpdate"; docId: string; suggestedBy?: Suggester } & ReplayedUpdate;
export type OverleafRemoteTextContext = {
  projectRoot: string;
  path: string;
  /** The text the new text was made from. */
  baseContent: string;
  /** The operations that turned `baseContent` into the new text. */
  ops: OtOp[];
  /**
   * Whether the buffer may already hold the writer's typing on top of
   * `baseContent`, to be carried onto the new text the way the server will
   * place it. True for a co-author's operation, which OT built on the text
   * this side last sent, for a replay carrying a resumed document's local
   * copy forward, and for a joined snapshot made from a held document's
   * settled local copy; false for any other joined snapshot, which the
   * buffer has to match (or already show) before anything is taken.
   */
  carryTyping: boolean;
  isCurrent: () => boolean;
};

export type OverleafRealtimeOptions = {
  /** The window's connection store, where the channel's status and tree live. */
  store: OverleafConnectionStore;
  /** Connect whenever the project is linked: chat and presence ride here too. */
  enabled: boolean;
  /**
   * Whether to edit the open file through the channel. Off in manual sync mode,
   * while the connection itself stays up so the rest of the bridge keeps
   * working.
   */
  documents: boolean;
  projectRoot: string | null;
  activeFile: string | null;
  /** Return false to preserve divergent local work and fall back to regular sync. */
  onRemoteText: (text: string, context: OverleafRemoteTextContext) => boolean | void | Promise<boolean | void>;
  onNotice: (message: string) => void;
  onNeedsSync?: (paths: readonly string[]) => void;
};

export const driftNotice = () => i18n._(msg`This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.`);
export const replacedNotice = () => i18n._(msg`Overleaf can't store emoji and some other special characters, so they were replaced with � — the same thing everyone else in the project sees.`);

/** Why ordinary sync is paused on a file whose last send has no proven outcome. */
export const unconfirmedNotice = (path: string | undefined, detail: string) => (path
  ? i18n._(msg`Lattice could not confirm whether Overleaf accepted the latest edit to ${path} (${detail}). Syncing is paused for this file while Lattice checks.`)
  : i18n._(msg`Lattice could not confirm whether Overleaf accepted the latest edit to this file (${detail}). Syncing is paused for this file while Lattice checks.`));
/** Why re-joining a held document cannot prove its last edit yet: the reason recorded, and the detail shown. */
export const unprovenJoin = (why: "noReplay" | "noPublicId", activeFile: string): [string, string] => (why === "noReplay"
  ? [
    i18n._(msg`Overleaf could not replay from the last version Lattice trusts`),
    i18n._(msg`Overleaf could not replay enough history to confirm the last edit to ${activeFile}. Syncing remains paused for this file.`),
  ]
  : [
    i18n._(msg`the connection id needed to classify replayed updates is not available`),
    i18n._(msg`Lattice cannot yet identify which replayed edits to ${activeFile} are its own. Syncing remains paused for this file.`),
  ]);
/** `attempt`, then again every `ms` for as long as `retry` says a failure is worth retrying. */
export const retrying = <T>(attempt: () => Promise<T>, ms: number, retry: (reason: unknown) => boolean): Promise<T> =>
  attempt().catch(async (reason: unknown) => {
    if (!retry(reason)) throw reason;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return retrying(attempt, ms, retry);
  });

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
 * Replay a join's catch-up into `doc`; our own updates coming back are acknowledgements.
 * With `stopAfterOurs`, nothing after our last update is applied: those were
 * built on text the operation changed outside `doc` (a reject's inverse), and
 * only a full re-join reads them correctly.
 */
export const replayInto = (doc: OtDocument, updates: ReplayedUpdate[], publicId: string | null, stopAfterOurs = false) => {
  const marked = updates.map((update) => ({ ...update, mine: isOwnUpdate(update.source, publicId, doc.submittedVia) }));
  let end = marked.length;
  if (stopAfterOurs) while (end > 0 && !marked[end - 1]!.mine) end -= 1;
  return doc.catchUp(end > 0 ? marked.slice(0, end) : marked);
};

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
/** overleaf_rt.rs's PROJECT_ACCESS_LOST: removed from the project, or it was deleted. */
export const OVERLEAF_PROJECT_ACCESS_LOST = "can no longer open the project";
/* eslint-enable lingui/no-unlocalized-strings */
export const isOverleafProjectRefusal = (reason: string) => mentionsAny(reason, [OVERLEAF_SESSION_STILL_VALID]);

/** Authentication and project-identity failures need user action, not a retry loop. */
export function shouldRetryConnection(reason: string): boolean {
  // The regex's words also catch what Overleaf's servers and the realtime
  // handshake say in their own words, so no Rust source pins them.
  // "not authorized" and "project not found" are how the realtime server
  // turns away an account removed from the project, or a deleted project.
  return !mentionsAny(reason, [OVERLEAF_NOT_CONNECTED, PROJECT_CHANGED, PROJECT_NOT_LINKED, NEWER_OVERLEAF_CONNECTION, OVERLEAF_PROJECT_ACCESS_LOST])
    && !/session expired|cookie|sign.?in|authentication|unauthori[sz]ed|not authori[sz]ed|forbidden|permission|invalid project|project not found/i.test(reason);
}

/**
 * What the channel shows while it waits `delayMs` to reconnect. The cause is
 * usually the host's English, so it reads in the interface language too.
 */
export function reconnectingDetail(cause: string, delayMs: number): string {
  const reason = hostErrorText(cause);
  const seconds = Math.ceil(delayMs / 1_000);
  return delayMs === 0
    ? i18n._(msg`Overleaf live editing disconnected (${reason}). Reconnecting now…`)
    : i18n._(msg`Overleaf live editing disconnected (${reason}). Reconnecting in ${seconds} s…`);
}

/**
 * Carry the open document's anchored spans across an operation.
 *
 * Overleaf states where comments and suggestions sit when the document is
 * joined and never mentions them again — they are expected to ride along on
 * the operations that move the text. Without this they drift, and a drifted
 * suggestion is worse than a misplaced highlight: accepting or rejecting one
 * applies to a range, so it would rewrite text nobody proposed touching.
 * Applies to our own typing as much as to anyone else's; `by` names who sent
 * `ops` as suggestions, when they were (see ./overleaf-suggestions).
 */
export function anchorsAfter(current: OpenDoc, ops: OtOp[], by: Suggester | null = null): Pick<OpenDoc, "comments" | "changes"> {
  return {
    comments: current.comments.map((comment) => {
      const from = transformSpan({ from: comment.position, length: comment.quote.length }, ops).from;
      return from === comment.position ? comment : { ...comment, position: from };
    }),
    changes: changesAfter(current.changes, ops, by),
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
