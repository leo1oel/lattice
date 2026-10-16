/**
 * The workspace's chunks App renders: the workspace itself and the project
 * PDF panel, behind ChunkGates, and its file tree and paper library (the
 * canvas's is use-preview-prewarm's loadDocumentCanvas). Each is the identity of its chunk
 * (see canvas/canvas-lazy-modules.ts).
 */
import { chunk } from "../lib/lazy-chunk";

export const loadTrellisWorkspace = chunk(() => import("../trellis/trellis-workspace"));
export const loadProjectFileTree = chunk(() => import("../project/project-file-tree"));
export const loadPaperLibrary = chunk(() => import("../project/paper-library"));
export const loadProjectPdfPanel = chunk(() => import("../canvas/project-pdf-panel"));
