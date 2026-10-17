import { chunk, lazyChunk } from "../lib/lazy-chunk";
import type { GatedSurface } from "../app/app-surfaces";
import type { DocumentCanvasProps } from "./canvas-model";

/** The document canvas's chunk: App gates the workspace's first frame on it and warms it as a project opens. */
const loadDocumentCanvas = chunk(() => import("./document-canvas"));

export const documentCanvasSurface: GatedSurface<DocumentCanvasProps> = {
  load: loadDocumentCanvas,
  Component: lazyChunk(loadDocumentCanvas, (module) => module.DocumentCanvas),
};
