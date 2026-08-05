/**
 * Local seam — not upstream code.
 *
 * Upstream `editor/clipboard/index.ts` is a barrel over the full clipboard
 * subsystem (sanitize/walker/source-clipboard), and its re-export chain
 * pulls a runtime yjs import (source-clipboard.ts — collab boundary).
 * Vendored files only consume the `OPT_OUT_ATTR` constant (chrome elements
 * marked with it are skipped by upstream's clipboard walker), so this seam
 * re-declares just that constant, byte-identical to upstream
 * `clipboard-sanitize.ts`.
 */
export const OPT_OUT_ATTR = "data-clipboard-omit" as const;
