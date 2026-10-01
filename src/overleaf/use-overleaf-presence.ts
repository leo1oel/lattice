/**
 * Who else is in the Overleaf project right now, and telling them about us.
 *
 * Overleaf announces nothing when someone joins — a browser tab that has been
 * open for an hour and one that just connected look identical until a
 * position is broadcast. So this owns two things at once: the roster (seeded
 * once from the connected-users snapshot, then kept live by two events) and
 * publishing our own caret, which is the only thing that makes us visible to
 * anyone else. It does not touch the editor or the document text — it only
 * ever sees `(row, column)` pairs, zero-based the way Overleaf counts them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onOverleafEvent } from "./overleaf-realtime-listen";

/** Someone else in the project, and where they are — the backend's own shape. */
export type PresenceUser = {
  /** Connection id: one person with two tabs open is two of these. */
  id: string;
  userId: string | null;
  name: string;
  email: string | null;
  /** Overleaf's id for the document they are in, when they have said. */
  docId: string | null;
  row: number | null;
  column: number | null;
  /** The hue Overleaf's own editor would give them. */
  hue: number;
};

type PresenceEvent = {
  projectRoot: string;
  type: string;
  user?: PresenceUser;
  id?: string;
};

/** Overleaf's own client: quiet while someone is watching, patient once alone. */
const DEBOUNCE_WITH_OTHERS_MS = 500;
const DEBOUNCE_ALONE_MS = 5 * 60 * 1000;
/** Comfortably inside the server's 15-minute expiry, so one missed tick never drops us. */
const KEEPALIVE_MS = 4 * 60 * 1000;

/**
 * How long the roster outlives a dropped connection. Most drops are a blip
 * the reconnect recovers from in a second or two, and clearing everyone at
 * once makes the toolbar flicker on every one of them.
 */
const DISCONNECT_GRACE_MS = 15_000;

/** One empty roster, so "nobody else is here" keeps a stable identity. */
const NO_PEERS: PresenceUser[] = [];

/** Tell Overleaf where our caret is; best effort, like every presence write. */
function sendPosition(projectRoot: string, docId: string, caret: { row: number; column: number }) {
  void invoke("overleaf_rt_update_position", { projectRoot, docId, row: caret.row, column: caret.column }).catch(() => {});
}

export type OverleafPresence = {
  /** Everyone else in the project. Our own entry is never in here. */
  peers: PresenceUser[];
  /**
   * The connection dropped and `peers` is what it said last: kept through a
   * short grace period instead of vanishing, but no longer confirmed.
   */
  reconnecting: boolean;
  /** Publish where our caret is; debounced, and a no-op with no document live. */
  publish: (row: number, column: number) => void;
};

export function useOverleafPresence(options: {
  /** Local project that owns the live connection. */
  projectRoot: string | null;
  /** Overleaf's id for the document being edited live, or null when none is. */
  docId: string | null;
  /** Our own connection id, so we never show ourselves as a collaborator. */
  selfId: string | null;
  /** Where our caret is right now, for the keepalive to re-publish without a fresh move. */
  readCaret: () => { row: number; column: number };
}): OverleafPresence {
  const [roster, setRoster] = useState<{ projectRoot: string | null; users: Map<string, PresenceUser>; stale?: boolean }>(
    { projectRoot: null, users: new Map() },
  );
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endGrace = () => {
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = null;
  };
  useEffect(() => endGrace, []);

  // The persistent listener below is registered once and outlives every prop
  // change, so it reads through a ref rather than closing over stale values.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- roster from events ---------------------------------------------
  // One listener for the life of the hook: presence events can arrive at any
  // time, including while the seed call below is still in flight, and a
  // listener that came and went with `selfId` could miss one in that window.
  useEffect(() => onOverleafEvent<PresenceEvent>((payload) => {
    // Backend cancellation cannot retract an event already queued for this
    // window. Never relabel an old project's event with the current root.
    const projectRoot = latest.current.projectRoot;
    if (!projectRoot || payload.projectRoot !== projectRoot) return;
    if (payload.type === "presenceUpdated" && payload.user) {
      const user = payload.user;
      // Our own move is echoed back like anyone else's; showing it would
      // make the roster claim we are our own collaborator.
      const selfId = latest.current.selfId;
      if (selfId && user.id === selfId) return;
      setRoster((current) => {
        // A roster still marked stale belongs to the connection that dropped;
        // the first live word from the new one starts afresh.
        const keep = current.projectRoot === projectRoot && !current.stale;
        const next = keep ? new Map(current.users) : new Map<string, PresenceUser>();
        next.set(user.id, user);
        return { projectRoot, users: next };
      });
    } else if (payload.type === "presenceLeft" && payload.id) {
      const id = payload.id;
      setRoster((current) => {
        if (current.projectRoot !== latest.current.projectRoot || !current.users.has(id)) return current;
        const next = new Map(current.users);
        next.delete(id);
        return { ...current, users: next };
      });
    } else if (payload.type === "disconnected") {
      // A dropped socket takes everyone with it at once, but most drops are
      // over before anyone could notice. Keep the roster, marked unconfirmed,
      // until the reconnect reseeds it — or until the grace period says the
      // drop is real and a roster from before it would claim people are here
      // who are not.
      setRoster((current) => (current.projectRoot === projectRoot ? { ...current, stale: true } : current));
      endGrace();
      graceTimer.current = setTimeout(() => {
        graceTimer.current = null;
        setRoster((current) => (current.stale ? { projectRoot: null, users: new Map() } : current));
      }, DISCONNECT_GRACE_MS);
    }
  }), []);

  // ---- seed the roster once we know who we are -------------------------
  // `selfId` only becomes non-null once the channel has told us so, which
  // makes it exactly the "on connect" moment the roster needs to be seeded.
  useEffect(() => {
    if (!options.selfId || !options.projectRoot) return;
    const selfId = options.selfId;
    const projectRoot = options.projectRoot;
    let cancelled = false;
    void invoke<PresenceUser[]>("overleaf_rt_connected_users", { projectRoot })
      .then((users) => {
        if (cancelled) return;
        endGrace();
        setRoster({
          projectRoot,
          users: new Map(
            users.filter((user) => user.id !== selfId).map((user) => [user.id, user]),
          ),
        });
      })
      .catch(() => {
        // The channel may not have finished connecting, or dropped while this
        // was in flight. Presence events (or the next connect) fill the
        // roster in from here; nothing beats showing a state we never confirmed.
      });
    return () => {
      cancelled = true;
    };
  }, [options.projectRoot, options.selfId]);

  // ---- announce ourselves, and keep doing so -------------------------------
  // Joining announces nothing on its own — only a position broadcast makes us
  // visible to a browser that is already open — so this fires once immediately
  // rather than waiting for the first debounced move, even at row 0 column 0.
  // The server also expires a presence entry after 15 minutes of silence, so
  // the keepalive keeps us listed through a long stretch of not moving.
  useEffect(() => {
    const docId = options.docId;
    const projectRoot = options.projectRoot;
    if (!docId || !projectRoot) return;
    const announce = () => sendPosition(projectRoot, docId, latest.current.readCaret());
    announce();
    const keepalive = setInterval(announce, KEEPALIVE_MS);
    return () => {
      clearInterval(keepalive);
      // A stale debounce aimed at the document we are leaving must never fire
      // against whatever document replaces it.
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    };
  }, [options.docId, options.projectRoot]);

  // ---- publish -------------------------------------------------------------
  const publish = useCallback((row: number, column: number) => {
    if (!options.docId || !options.projectRoot) return;
    const projectRoot = options.projectRoot;
    const alone = roster.projectRoot !== projectRoot || roster.users.size === 0;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      const docId = latest.current.docId;
      if (docId) sendPosition(projectRoot, docId, { row, column });
    }, alone ? DEBOUNCE_ALONE_MS : DEBOUNCE_WITH_OTHERS_MS);
  }, [options.docId, options.projectRoot, roster]);

  // Rebuilding this list on every render gave it a new identity on every
  // keystroke, which walked all the way down to a CodeMirror transaction that
  // repainted remote carets while you typed — including in projects that were
  // never linked to Overleaf, where the list is always empty.
  const peers = useMemo(
    () => (options.projectRoot && roster.projectRoot === options.projectRoot
      ? Array.from(roster.users.values())
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      : NO_PEERS),
    [options.projectRoot, roster],
  );

  const reconnecting = Boolean(options.projectRoot && roster.projectRoot === options.projectRoot && roster.stale);
  return { peers, reconnecting, publish };
}
