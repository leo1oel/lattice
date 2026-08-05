/**
 * Local seam — not upstream code.
 *
 * Upstream `editor/observers.ts` is the client-side Y.XmlFragment/Y.Text
 * observer shell (imports @hocuspocus/server + yjs — collab boundary, never
 * vendored). The only export the vendored editor UI consumes is
 * `markUserTyping`, a global wall-clock keystroke timestamp used by
 * upstream's agent-presence typing guard. This host has no agent-presence
 * subscriber, but the timestamp is kept live so the call sites stay
 * upstream-identical and any future consumer reads real data.
 */

let lastGlobalUserKeystrokeMs = 0;

export function markUserTyping(): void {
  lastGlobalUserKeystrokeMs = Date.now();
}

export function getLastGlobalUserKeystrokeMs(): number {
  return lastGlobalUserKeystrokeMs;
}
