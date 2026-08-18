/**
 * Chunk prewarming for the document canvas.
 *
 * Separate from `document-canvas.tsx` so that file exports components only and
 * keeps Fast Refresh. App drives the timing (idle-gated); this module only
 * decides which chunks a given project needs.
 */
import {
  loadBoardEditorModule,
  loadPdfPreviewModule,
  loadSpreadsheetEditorModule,
  loadVisualMarkdownEditorModule,
} from "./canvas-lazy-modules";
import { loadTextLanguageExtensions } from "../editor/editor-languages";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";

/** Download project-relevant editor and preview chunks without mounting UI. */
export async function prewarmProjectPreviewModules(paths: readonly string[]): Promise<void> {
  const normalized = paths.map((path) => path.toLocaleLowerCase());
  const representativeLanguages = new Map<string, string>();
  for (const path of paths) {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    if (filename !== ".gitignore" && !/\.(?:tex|bib|mdx?|txt|html?|sty|cls|bst)$/i.test(filename)) continue;
    const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : filename;
    if (!representativeLanguages.has(extension)) representativeLanguages.set(extension, path);
  }
  const work: Promise<unknown>[] = [...representativeLanguages.values()].map(loadTextLanguageExtensions);
  if (normalized.some((path) => path.endsWith(".md") || path.endsWith(".mdx"))) {
    work.push(loadVisualMarkdownEditorModule());
  }
  if (normalized.some((path) => path.endsWith(".tex") || path.endsWith(".pdf"))) {
    work.push(loadPdfPreviewModule());
  }
  if (normalized.some((path) => path.endsWith(".tldr"))) {
    work.push(Promise.all([
      loadBoardEditorModule(),
      import("../editor/board/board-yjs-bridge"),
    ]).then(([, board]) => {
      // Initialize tldraw's schema/store machinery without mounting a canvas
      // or attaching a writable collaboration bridge.
      board.createBoardStore("");
    }));
  }
  if (normalized.some(isSpreadsheetPath)) {
    work.push(loadSpreadsheetEditorModule());
  }
  await Promise.allSettled(work);
}

/** Parse one Markdown document into the visual editor's bounded warm cache. */
export async function prewarmMarkdownPreviewDocument(path: string, source: string): Promise<void> {
  const module = await loadVisualMarkdownEditorModule();
  module.prewarmVisualMarkdownDocument(path, source);
}
