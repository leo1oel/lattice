/**
 * The workspace's chunks App renders: the workspace itself, behind a
 * ChunkGate, and its file tree and paper library. The canvas and the project
 * PDF panel come with App's surfaces (app-surfaces.ts). Each is the identity
 * of its chunk (see canvas/canvas-lazy-modules.ts).
 */
import { chunk } from "../lib/lazy-chunk";

export const loadTrellisWorkspace = chunk(() => import("../trellis/trellis-workspace"));
export const loadProjectFileTree = chunk(() => import("../project/project-file-tree"));
export const loadPaperLibrary = chunk(() => import("../project/paper-library"));
