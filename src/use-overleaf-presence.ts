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
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  type: string;
  user?: PresenceUser;
  id?: string;
};

/** Overleaf's own client: quiet while someone is watching, patient once alone. */
const DEBOUNCE_WITH_OTHERS_MS = 500;
const DEBOUNCE_ALONE_MS = 5 * 60 * 1000;
/** Comfortably inside the server's 15-minute expiry, so one missed tick never drops us. */
const KEEPALIVE_MS = 4 * 60 * 1000;

export type OverleafPresence = {
  /** Everyone else in the project. Our own entry is never in here. */
  peers: PresenceUser[];
  /** Publish where our caret is; debounced, and a no-op with no document live. */
  publish: (row: number, column: number) => void;
};

export function useOverleafPresence(options: {
  /** Overleaf's id for the document being edited live, or null when none is. */
  docId: string | null;
  /** Our own connection id, so we never show ourselves as a collaborator. */
  selfId: string | null;
  /** Where our caret is right now, for the keepalive to re-publish without a fresh move. */
  readCaret: () => { row: number; column: number };
}): OverleafPresence {
  const [roster, setRoster] = useState<Map<string, PresenceUser>>(new Map());

  // The persistent listener below is registered once and outlives every prop
  // change, so it reads through refs rather than closing over stale values.
  const selfIdRef = useRef(options.selfId);
  const docIdRef = useRef(options.docId);
  const readCaretRef = useRef(options.readCaret);
  useEffect(() => {
    selfIdRef.current = options.selfId;
    docIdRef.current = options.docId;
    readCaretRef.current = options.readCaret;
  });

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- roster from events ---------------------------------------------
  // One listener for the life of the hook: presence events can arrive at any
  // time, including while the seed call below is still in flight, and a
  // listener that came and went with `selfId` could miss one in that window.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<PresenceEvent>("overleaf-realtime", (event) => {
      const payload = event.payload;
      if (payload.type === "presenceUpdated" && payload.user) {
        const user = payload.user;
        // Our own move is echoed back like anyone else's; showing it would
        // make the roster claim we are our own collaborator.
        if (selfIdRef.current && user.id === selfIdRef.current) return;
        setRoster((current) => {
          const next = new Map(current);
          next.set(user.id, user);
          return next;
        });
        return;
      }
      if (payload.type === "presenceLeft" && payload.id) {
        const id = payload.id;
        setRoster((current) => {
          if (!current.has(id)) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
        return;
      }
      if (payload.type === "disconnected") {
        // A dropped socket takes everyone with it at once; a roster left over
        // from before it dropped would claim people are here who are not.
        setRoster(new Map());
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ---- seed the roster once we know who we are -------------------------
  // `selfId` only becomes non-null once the channel has told us so, which
  // makes it exactly the "on connect" moment the roster needs to be seeded.
  useEffect(() => {
    if (!options.selfId) return;
    const selfId = options.selfId;
    let cancelled = false;
    void invoke<PresenceUser[]>("overleaf_rt_connected_users")
      .then((users) => {
        if (cancelled) return;
        setRoster(new Map(
          users.filter((user) => user.id !== selfId).map((user) => [user.id, user]),
        ));
      })
      .catch(() => {
        // The channel may not have finished connecting, or dropped while this
        // was in flight. Presence events (or the next connect) fill the
        // roster in from here; nothing beats showing a state we never confirmed.
      });
    return () => {
      cancelled = true;
    };
  }, [options.selfId]);

  // ---- announce ourselves the moment a document is joined ---------------
  // Joining announces nothing on its own — only a position broadcast makes us
  // visible to a browser that is already open — so this fires once immediately
  // rather than waiting for the first debounced move, even at row 0 column 0.
  useEffect(() => {
    if (!options.docId) return;
    const docId = options.docId;
    const caret = readCaretRef.current();
    void invoke("overleaf_rt_update_position", { docId, row: caret.row, column: caret.column }).catch(() => {});
    return () => {
      // A stale debounce aimed at the document we are leaving must never fire
      // against whatever document replaces it.
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [options.docId]);

  // ---- keepalive ---------------------------------------------------------
  // The server expires a presence entry after 15 minutes of silence, which
  // would make us vanish even with a healthy socket; re-publishing well inside
  // that window keeps us listed through a long stretch of not touching the caret.
  useEffect(() => {
    if (!options.docId) return;
    const docId = options.docId;
    const timer = setInterval(() => {
      const caret = readCaretRef.current();
      void invoke("overleaf_rt_update_position", { docId, row: caret.row, column: caret.column }).catch(() => {});
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [options.docId]);

  // ---- publish -------------------------------------------------------------
  const publish = useCallback((row: number, column: number) => {
    if (!options.docId) return;
    const alone = roster.size === 0;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      const docId = docIdRef.current;
      if (!docId) return;
      void invoke("overleaf_rt_update_position", { docId, row, column }).catch(() => {});
    }, alone ? DEBOUNCE_ALONE_MS : DEBOUNCE_WITH_OTHERS_MS);
  }, [options.docId, roster]);

  const peers = Array.from(roster.values()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return { peers, publish };
}
