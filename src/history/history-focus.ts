/**
 * The project-history entry the drawer was last asked to open on (a revision
 * round's "Open in History"), as a small store: the drawer reads it while it
 * is open, and nothing else renders for it.
 */
type HistoryFocus = { id: string; nonce: string };

let focus: HistoryFocus | null = null;
const listeners = new Set<() => void>();

export function focusHistoryEntry(id: string | null) {
  focus = id ? { id, nonce: crypto.randomUUID() } : null;
  for (const listener of [...listeners]) listener();
}

export function subscribeHistoryFocus(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const historyFocus = () => focus;
