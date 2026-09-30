/**
 * Accepting, rejecting, and naming Overleaf's tracked-change suggestions.
 *
 * Accepting or rejecting is an endpoint, not an operation on the editing
 * channel: nothing tells `useOverleafRealtime` the ranges moved once it
 * happens, so every action here ends by calling the caller's `reload`.
 *
 * Author names come from their own endpoint because a suggestion can outlive
 * its author's membership in the project; folding the lookup into the change
 * list would lose the name the moment someone left.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { ReservedOperation, TrackedChange } from "./use-overleaf-realtime";

type ChangeAuthor = { id: string; email: string | null; firstName: string | null; lastName: string | null };

/**
 * `overleaf_change_authors` hands back Overleaf's raw response, whose envelope
 * is not part of this app's contract — only that it holds objects with
 * `id`/`email`/`first_name`/`last_name` somewhere. Pulling out what is
 * recognized means a shape change costs a missing name, not a crash.
 */
function parseChangeAuthors(raw: unknown): ChangeAuthor[] {
  const users = (raw as { users?: unknown } | null)?.users;
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray(users) ? users : [];
  return list.flatMap((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const read = (key: string) => (typeof record[key] === "string" && record[key] ? record[key] as string : null);
    const id = read("id");
    return id ? [{ id, email: read("email"), firstName: read("first_name"), lastName: read("last_name") }] : [];
  });
}

/** "First Last", else the part of the email before the @, else the localized fallback. */
function displayName(author: ChangeAuthor | undefined, fallback: string): string {
  const full = [author?.firstName, author?.lastName].filter(Boolean).join(" ");
  const email = author?.email;
  return full || (email ? email.slice(0, email.indexOf("@") > 0 ? email.indexOf("@") : undefined) : fallback);
}

export function useOverleafTrackChanges(options: {
  enabled: boolean;
  projectRoot: string | null;
  /** Overleaf's id for the open document; accept and reject are keyed on it. */
  docId: string | null;
  /**
   * Take the wire and answer with the version to build reject's inverse
   * operation on. Rejecting at the version the document was joined at is
   * stale the moment anybody types: the server then applies the inverse
   * against a history it no longer has, and mangles or refuses it.
   */
  reserveOperation: () => ReservedOperation | null;
  /** Reconcile a reserved reject whose send outcome could not be proven. */
  noteReservedOperationUnknown: (reservation: ReservedOperation, reason: unknown) => void;
  /**
   * The current version only when the OT document is settled. Accepting is a
   * REST mutation, so it checks the wire without reserving it: an empty OT
   * reservation would never receive an acknowledgement.
   */
  settledVersion: () => number | null;
  changes: TrackedChange[];
  /** False for a read-only or suggest-only account: Overleaf refuses both calls for them. */
  canAct: boolean;
  reload: () => void;
}) {
  const { t } = useLingui();
  const [authors, setAuthors] = useState<Map<string, ChangeAuthor>>(new Map());
  /** The id of whichever change is mid-request; "all" for a bulk action; else null. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Actions finish asynchronously after the render that started them, so they
  // read the latest options rather than the ones they closed over.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // Keyed on which suggestions exist, not on the array's identity: a caller
  // that doesn't memoize it would otherwise re-fetch on every commit.
  const changeIdsKey = options.changes.map((change) => change.id).join(",");
  const { enabled, projectRoot } = options;
  useEffect(() => {
    if (!enabled || !changeIdsKey) {
      // Deferred rather than called straight from the effect body, which the
      // lint config flags as a cascading render.
      queueMicrotask(() => setAuthors(new Map()));
      return;
    }
    if (!projectRoot) return;
    let cancelled = false;
    invoke<unknown>("overleaf_change_authors", { projectRoot })
      .then((raw) => {
        if (!cancelled) setAuthors(new Map(parseChangeAuthors(raw).map((author) => [author.id, author])));
      })
      // Cosmetic only: a suggestion with no resolvable name still shows, and
      // can still be accepted or rejected.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, changeIdsKey, projectRoot]);

  const unknownAuthor = t`Unknown`;
  const authorName = useCallback(
    (userId: string | null) => displayName(userId ? authors.get(userId) : undefined, unknownAuthor),
    [authors, unknownAuthor],
  );

  /** Run an action for `ids`; it answers with the document it changed, which is reloaded if still open. */
  const run = useCallback(async (ids: string[], action: (current: typeof options) => Promise<string>) => {
    if (!ids.length) return;
    if (!latest.current.canAct) {
      const message = t`This account cannot accept or reject suggestions here.`;
      setError(message);
      throw new Error(message);
    }
    setBusy(ids.length === 1 ? ids[0]! : "all");
    setError(null);
    try {
      const targetDocId = await action(latest.current);
      // The mutation belongs to the document captured by the request. If the
      // writer moved meanwhile, reloading the newly visible document is both
      // unrelated and disruptive; reopening the target observes the change.
      if (latest.current.docId === targetDocId) latest.current.reload();
    } catch (reason) {
      setError(String(reason));
      throw reason;
    } finally {
      setBusy(null);
    }
  }, [t]);

  const accept = useCallback((changeIds: string[]) => run(changeIds, async ({ docId, projectRoot, settledVersion }) => {
    if (!docId) throw new Error(t`Open the document this suggestion is in first.`);
    if (!projectRoot) throw new Error(t`Open the linked Overleaf project first.`);
    if (settledVersion() === null) {
      throw new Error(t`An edit is still on its way to Overleaf. Try accepting again in a moment.`);
    }
    await invoke("overleaf_accept_changes", { projectRoot, docId, changeIds });
    return docId;
  }), [run, t]);

  const reject = useCallback((toReject: TrackedChange[]) => run(toReject.map((change) => change.id), async (current) => {
    if (!current.docId) throw new Error(t`Open the document this suggestion is in first.`);
    if (!current.projectRoot) throw new Error(t`Open the linked Overleaf project first.`);
    const reservation = current.reserveOperation();
    if (reservation === null) {
      throw new Error(t`An edit is still on its way to Overleaf. Try rejecting again in a moment.`);
    }
    try {
      await invoke("overleaf_reject_changes", {
        projectRoot: current.projectRoot,
        docId: reservation.docId,
        version: reservation.version,
        changes: toReject,
      });
    } catch (reason) {
      current.noteReservedOperationUnknown(reservation, reason);
      throw reason;
    }
    return reservation.docId;
  }), [run, t]);

  return { authorName, busy, error, accept, reject };
}
