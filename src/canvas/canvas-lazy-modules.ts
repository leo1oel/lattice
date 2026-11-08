/**
 * The canvas's heavy editors and previews, behind dynamic imports, outside
 * `document-canvas.tsx` so that file exports components only (Fast Refresh).
 *
 * Each loader is the identity of a chunk. Import them; an inline
 * `import("../pdf/pdf-viewer")` at a call site gets its own copy of the module
 * graph in a second chunk. Each is a shared `chunk`, so the editor a prewarm
 * has loaded renders without suspending (`lazyChunk`).
 */
import { chunk } from "../lib/lazy-chunk";

let visualMarkdownEditorWarmed = false;

export const loadPdfPreviewModule = chunk(() => import("../pdf/pdf-viewer"));

/** Finding a passage of a paper's full text in its PDF, for a source link to its page. */
export const loadPdfQuotePageModule = chunk(() => import("../pdf/pdf-quote-page"));

/** The visual Markdown editor (Lattice's own engine). */
export const loadVisualMarkdownEditorModule = chunk(() => import("../editor/markdown/engine/lattice-visual-editor")
  .then((module) => {
    // Chunk prewarm finished — skip DeferredVisualMarkdownEditor's one-frame blank.
    visualMarkdownEditorWarmed = true;
    return module;
  }));

/** Whether the visual Markdown chunk is already resolved, so a mount can be immediate. */
export const isVisualMarkdownEditorWarmed = () => visualMarkdownEditorWarmed;

/** Record that the editor has mounted once, so later mounts skip the deferral frame. */
export const markVisualMarkdownEditorWarmed = () => {
  visualMarkdownEditorWarmed = true;
};

// The website's demo (src/web-demo/) has no whiteboard or Open Slide: it shows
// a card saying they run on the Mac, and its build leaves tldraw out.
export const loadBoardEditorModule = chunk(() => (import.meta.env.LATTICE_WEB_DEMO
  ? import("../web-demo/desktop-only")
  : import("../editor/board/board-editor")));

export const loadSpreadsheetEditorModule = chunk(() => import("../editor/spreadsheet/spreadsheet-editor"));

export const loadOpenSlideWorkspaceModule = chunk(() => (import.meta.env.LATTICE_WEB_DEMO
  ? import("../web-demo/desktop-only")
  : import("../editor/presentation/open-slide-workspace")));

/** A .bib file's visual form: the reference list. */
export const loadBibVisualEditorModule = chunk(() => import("../papers/bib-visual-editor"));

/** The .bib parser on its own, for deciding whether the reference list can show (it shares it). */
export const loadBibDocumentModule = () => import("../papers/bib-document");
