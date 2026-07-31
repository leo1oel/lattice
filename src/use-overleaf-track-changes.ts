/**
 * Accepting, rejecting, and naming Overleaf's tracked-change suggestions.
 *
 * Accepting or rejecting is an endpoint, not an operation on the editing
 * channel: nothing tells `useOverleafRealtime` the ranges moved once it
 * happens, so every action here ends by calling the caller's `reload` —
 * exactly the contract `useOverleafRealtime`'s own doc comment describes.
 *
 * Author names are fetched separately from the suggestions themselves.
 * Overleaf keeps that list behind its own endpoint precisely because a
 * suggestion can outlive its author's membership in the project; folding the
 * lookup into the change list would mean losing the name the moment someone
 * left, which is the one case this endpoint exists to cover.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ReservedOperation, TrackedChange } from "./use-overleaf-realtime";

/** One entry from `overleaf_change_authors`, once the naming is made safe. */
type ChangeAuthor = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * `overleaf_change_authors` hands back Overleaf's raw response verbatim, and
 * its exact envelope is not part of this app's contract — only that it holds
 * objects with `id`/`email`/`first_name`/`last_name` somewhere. Accepting
 * `unknown` and pulling out what is recognized means a shape Overleaf never
 * documented shifting under us costs a missing name, not a crash.
 */
function parseChangeAuthors(raw: unknown): ChangeAuthor[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.users)
      ? raw.users
      : [];
  const authors: ChangeAuthor[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = readString(item, "id");
    if (!id) continue;
    authors.push({
      id,
      email: readString(item, "email"),
      firstName: readString(item, "first_name"),
      lastName: readString(item, "last_name"),
    });
  }
  return authors;
}

/** "First Last", else the part of the email before the @, else "Unknown". */
function displayName(author: ChangeAuthor | undefined): string {
  if (!author) return "Unknown";
  const full = [author.firstName, author.lastName].filter(Boolean).join(" ");
  if (full) return full;
  if (author.email) {
    const at = author.email.indexOf("@");
    return at > 0 ? author.email.slice(0, at) : author.email;
  }
  return "Unknown";
}

export type OverleafTrackChanges = {
  /** Display name for a suggestion's author, else "Unknown". */
  authorName: (userId: string | null) => string;
  /** The id of whichever change is mid-request; "all" for a bulk action; else null. */
  busy: string | null;
  error: string | null;
  accept: (changeIds: string[]) => Promise<void>;
  reject: (changes: TrackedChange[]) => Promise<void>;
};

export function useOverleafTrackChanges(options: {
  enabled: boolean;
  projectRoot: string | null;
  /** Overleaf's id for the open document; accept and reject are keyed on it. */
  docId: string | null;
  /**
   * Take the wire and answer with the version to build reject's inverse
   * operation on. Rejecting used to be sent at the version the document was
   * joined at, which is stale the moment anybody types: the server then
   * applies the inverse operation against a history it no longer has, and
   * either mangles it or refuses it outright and stops live editing.
   */
  reserveOperation: () => ReservedOperation | null;
  /** Reconcile a reserved reject whose send outcome could not be proven. */
  noteReservedOperationUnknown: (reservation: ReservedOperation, reason: unknown) => void;
  /**
   * Read the current version only when the OT document is settled. Accepting
   * is a REST mutation, so it must check the wire without reserving it: an
   * empty OT reservation would never receive an acknowledgement.
   */
  settledVersion: () => number | null;
  changes: TrackedChange[];
  /** False for a read-only or suggest-only account: Overleaf refuses both calls for them. */
  canAct: boolean;
  reload: () => void;
}): OverleafTrackChanges {
  const [authors, setAuthors] = useState<Map<string, ChangeAuthor>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const docId = useRef(options.docId);
  const projectRoot = useRef(options.projectRoot);
  const reserveOperation = useRef(options.reserveOperation);
  const noteReservedOperationUnknown = useRef(options.noteReservedOperationUnknown);
  const settledVersion = useRef(options.settledVersion);
  const canAct = useRef(options.canAct);
  const reload = useRef(options.reload);
  // Kept current from an effect rather than assigned during render: refs are
  // only ever read from later, asynchronous callbacks (accept/reject/reload),
  // never during this render itself, so there is nothing to gain from
  // writing them before the commit that would otherwise use them.
  useEffect(() => {
    docId.current = options.docId;
    projectRoot.current = options.projectRoot;
    reserveOperation.current = options.reserveOperation;
    noteReservedOperationUnknown.current = options.noteReservedOperationUnknown;
    settledVersion.current = options.settledVersion;
    canAct.current = options.canAct;
    reload.current = options.reload;
  });

  const enabled = options.enabled;
  // Keyed on which suggestions exist, not on `options.changes`'s own identity:
  // a caller that doesn't memoize its array (or a test that doesn't) would
  // otherwise hand us a new reference every render and re-trigger this on
  // every commit, forever.
  const changeIdsKey = options.changes.map((change) => change.id).join(",");

  useEffect(() => {
    if (!enabled || !changeIdsKey) {
      // Deferred rather than called straight from the effect body: setting
      // state synchronously there is exactly the cascading-render pattern
      // this repo's lint config flags, even though the reset itself is trivial.
      queueMicrotask(() => setAuthors(new Map()));
      return;
    }
    let cancelled = false;
    if (!options.projectRoot) return;
    invoke<unknown>("overleaf_change_authors", { projectRoot: options.projectRoot })
      .then((raw) => {
        if (!cancelled) setAuthors(new Map(parseChangeAuthors(raw).map((author) => [author.id, author])));
      })
      .catch(() => {
        // Cosmetic only: a suggestion with no resolvable name still shows,
        // and can still be accepted or rejected.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, changeIdsKey, options.projectRoot]);

  const authorName = useCallback(
    (userId: string | null) => displayName(userId ? authors.get(userId) : undefined),
    [authors],
  );

  /** One id → busy as itself; several → busy as "all", for a bulk button's spinner. */
  const keyFor = (ids: string[]): string => (ids.length === 1 ? ids[0]! : "all");

  const run = useCallback(async (ids: string[], action: () => Promise<string>) => {
    if (!ids.length) return;
    if (!canAct.current) {
      const message = "This account cannot accept or reject suggestions here.";
      setError(message);
      throw new Error(message);
    }
    setBusy(keyFor(ids));
    setError(null);
    try {
      const targetDocId = await action();
      // The mutation belongs to the document captured by the request. If the
      // writer moved meanwhile, reloading the newly visible document is both
      // unrelated and potentially disruptive; reopening the target performs a
      // fresh join and observes the mutation there.
      if (docId.current === targetDocId) reload.current();
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setBusy(null);
    }
  }, []);

  const accept = useCallback((changeIds: string[]) => run(changeIds, async () => {
    const targetDocId = docId.current;
    if (!targetDocId) throw new Error("Open the document this suggestion is in first.");
    const targetRoot = projectRoot.current;
    if (!targetRoot) throw new Error("Open the linked Overleaf project first.");
    if (settledVersion.current() === null) {
      throw new Error(
        "An edit is still on its way to Overleaf. Try accepting again in a moment.",
      );
    }
    await invoke("overleaf_accept_changes", {
      projectRoot: targetRoot,
      docId: targetDocId,
      changeIds,
    });
    return targetDocId;
  }), [run]);

  const reject = useCallback((toReject: TrackedChange[]) => run(
    toReject.map((change) => change.id),
    async () => {
      if (!docId.current) throw new Error("Open the document this suggestion is in first.");
      const targetRoot = projectRoot.current;
      if (!targetRoot) throw new Error("Open the linked Overleaf project first.");
      const reservation = reserveOperation.current();
      if (reservation === null) {
        throw new Error(
          "An edit is still on its way to Overleaf. Try rejecting again in a moment.",
        );
      }
      try {
        await invoke("overleaf_reject_changes", {
          projectRoot: targetRoot,
          docId: reservation.docId,
          version: reservation.version,
          changes: toReject,
        });
      } catch (reason) {
        noteReservedOperationUnknown.current(reservation, reason);
        throw reason;
      }
      return reservation.docId;
    },
  ), [run]);

  return { authorName, busy, error, accept, reject };
}
