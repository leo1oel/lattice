import { chunk, lazyChunk } from "../lib/lazy-chunk";
import type { GatedSurface } from "../app/app-surfaces";
import type { ProjectPdfPanelProps } from "./project-pdf-panel";

const loadProjectPdfPanel = chunk(() => import("./project-pdf-panel"));

export const projectPdfPanelSurface: GatedSurface<ProjectPdfPanelProps> = {
  load: loadProjectPdfPanel,
  Component: lazyChunk(loadProjectPdfPanel, (module) => module.ProjectPdfPanel),
};
