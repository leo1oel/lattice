import type { ComponentType } from "react";
import type { Chunk } from "../lib/lazy-chunk";
import type { DocumentCanvasProps } from "../canvas/canvas-model";
import type { ProjectPdfPanelProps } from "../canvas/project-pdf-panel";
import type { SettingsDialogProps } from "../settings/settings-dialog";

/** A part of a project's first frame: App renders `Component` behind a ChunkGate on `load`. */
export type GatedSurface<P> = Readonly<{ load: Chunk<unknown>; Component: ComponentType<P> }>;

/**
 * The feature surfaces App renders but does not import. `main.tsx` hands App
 * the production ones (`production-surfaces.ts`); an App integration suite
 * hands it the real surface of the feature it tests and inert doubles for the
 * rest. A static or lazy import here would put every surface in the import
 * graph of every suite that mounts App, and Vitest's related-test selection
 * follows that graph, lazy imports included: a canvas change would rerun the
 * Settings suites. Only types cross this file.
 */
export type AppSurfaces = Readonly<{
  documentCanvas: GatedSurface<DocumentCanvasProps>;
  projectPdfPanel: GatedSurface<ProjectPdfPanelProps>;
  settingsDialog: ComponentType<SettingsDialogProps>;
}>;
