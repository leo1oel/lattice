/**
 * The canvas's heavy editors and previews, behind dynamic imports, outside
 * `document-canvas.tsx` so that file exports components only (Fast Refresh).
 *
 * Each loader is the identity of a chunk. Import them; an inline
 * `import("../pdf/pdf-viewer")` at a call site gets its own copy of the module
 * graph in a second chunk.
 */
let visualMarkdownEditorWarmed = false;

export const loadPdfPreviewModule = () => import("../pdf/pdf-viewer");

export const loadVisualMarkdownEditorModule = () => import("../editor/markdown/visual-markdown-editor")
  .then((module) => {
    // Chunk prewarm finished — skip DeferredVisualMarkdownEditor's one-frame blank.
    visualMarkdownEditorWarmed = true;
    return module;
  });

/** The clean-room visual Markdown engine, used when the `visualEditorEngine` setting is `lattice`. */
export const loadLatticeVisualEditorModule = () => import("../editor/markdown/engine/lattice-visual-editor");

/** Whether the visual Markdown chunk is already resolved, so a mount can be immediate. */
export const isVisualMarkdownEditorWarmed = () => visualMarkdownEditorWarmed;

/** Record that the editor has mounted once, so later mounts skip the deferral frame. */
export const markVisualMarkdownEditorWarmed = () => {
  visualMarkdownEditorWarmed = true;
};

export const loadBoardEditorModule = () => import("../editor/board/board-editor");

export const loadSpreadsheetEditorModule = () => import("../editor/spreadsheet/spreadsheet-editor");

export const loadOpenSlideWorkspaceModule = () => import("../editor/presentation/open-slide-workspace");
