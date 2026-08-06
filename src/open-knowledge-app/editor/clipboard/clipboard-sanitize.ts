/**
 * Local seam — not upstream code.
 *
 * Upstream moved `OPT_OUT_ATTR` out of the `editor/clipboard/index.ts` barrel
 * and into `clipboard-sanitize.ts`, so vendored files now import it from this
 * path. The full upstream module is the clipboard sanitize/walker subsystem,
 * whose re-export chain reaches a runtime yjs import (source-clipboard.ts —
 * collab boundary). Vendored files only consume the constant, so re-export it
 * from the existing barrel seam rather than vendoring 550 lines of clipboard
 * machinery this host does not run.
 */
export { OPT_OUT_ATTR } from "./index.ts";
