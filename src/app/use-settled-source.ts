import { useEffect, useRef, useState } from "react";

/**
 * Size at which a buffer's document-wide derivations stop following every
 * keystroke. Below it they cost well under a millisecond and stay live; a
 * 3 MB thesis-in-one-file spent about 30 ms per keystroke on them in Chromium
 * and 45 ms in WebKit (word count, TODO rescan, labels, macros, outline,
 * appendix marker).
 */
export const LONG_SOURCE_CHARS = 100_000;
/** Quiet time after the last edit before a long buffer's derivations catch up. */
const SETTLE_IDLE_MS = 500;
/** Continuous typing still refreshes them this often. */
const SETTLE_MAX_MS = 5_000;

/**
 * `source` for the work that reads the whole document rather than the caret's
 * neighbourhood: status-bar counts, TODOs, the outline and breadcrumb, labels,
 * macros, the appendix marker. For a long buffer this is the text as of the
 * last pause in typing (at most SETTLE_MAX_MS old), so that work runs once per
 * pause instead of once per keystroke; the editor itself always shows the live
 * text. A short buffer, a newly opened one and one that has just grown long
 * read live, so nothing shows another document's or a half-loaded state.
 *
 * `key` names the buffer (project and path): a new key starts from its live
 * text immediately.
 */
export function useSettledSource(key: string, source: string): string {
  const [settled, setSettled] = useState({ key, source });
  // Adjusting state while rendering (not in an effect) re-renders before
  // commit, so switching documents never shows the previous one's snapshot.
  if (settled.key !== key) setSettled({ key, source });
  const pendingSinceRef = useRef<number | null>(null);
  const long = source.length >= LONG_SOURCE_CHARS;
  useEffect(() => {
    if (!long || settled.source === source) {
      pendingSinceRef.current = null;
      return;
    }
    const now = performance.now();
    const pendingSince = pendingSinceRef.current ?? now;
    pendingSinceRef.current = pendingSince;
    const timer = window.setTimeout(() => {
      pendingSinceRef.current = null;
      setSettled({ key, source });
    }, Math.max(0, Math.min(SETTLE_IDLE_MS, pendingSince + SETTLE_MAX_MS - now)));
    return () => window.clearTimeout(timer);
  }, [key, long, settled.source, source]);
  return long && settled.key === key && settled.source.length >= LONG_SOURCE_CHARS ? settled.source : source;
}
