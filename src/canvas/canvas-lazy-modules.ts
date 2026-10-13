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

export const loadBoardEditorModule = chunk(() => import("../editor/board/board-editor"));

export const loadSpreadsheetEditorModule = chunk(() => import("../editor/spreadsheet/spreadsheet-editor"));

export const loadOpenSlideWorkspaceModule = chunk(() => import("../editor/presentation/open-slide-workspace"));

/** A .bib file's visual form: the reference list. */
export const loadBibVisualEditorModule = chunk(() => import("../papers/bib-visual-editor"));

/** The .bib parser on its own, for deciding whether the reference list can show (it shares it). */
export const loadBibDocumentModule = () => import("../papers/bib-document");
