/**
 * The canvas's heavy editors and previews, behind dynamic imports.
 *
 * They live outside `document-canvas.tsx` so that file exports components only
 * and keeps Fast Refresh: one shared function export there invalidates the
 * whole module on every edit, and it is the largest file in the app.
 *
 * Each loader is the identity of a chunk. Import them; do not inline
 * `import("../pdf/pdf-viewer")` at a call site, or that site gets its own copy of
 * the module graph in a second chunk.
 */
let visualMarkdownEditorWarmed = false;

export const loadPdfPreviewModule = () => import("../pdf/pdf-viewer");

export const loadVisualMarkdownEditorModule = () => import("../editor/markdown/visual-markdown-editor")
  .then((module) => {
    // Chunk prewarm finished — skip DeferredVisualMarkdownEditor's one-frame blank.
    visualMarkdownEditorWarmed = true;
    return module;
  });

/** Whether the visual Markdown chunk is already resolved, so a mount can be immediate. */
export const isVisualMarkdownEditorWarmed = () => visualMarkdownEditorWarmed;

/** Record that the editor has mounted once, so later mounts skip the deferral frame. */
export const markVisualMarkdownEditorWarmed = () => {
  visualMarkdownEditorWarmed = true;
};

export const loadBoardEditorModule = () => import("../editor/board/board-editor");

export const loadSpreadsheetEditorModule = () => import("../editor/spreadsheet/spreadsheet-editor");

export const loadPresentationEditorModule = () => import("../editor/presentation/presentation-editor");
