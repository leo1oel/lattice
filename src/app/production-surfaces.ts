import { documentCanvasSurface } from "../canvas/document-canvas-surface";
import { projectPdfPanelSurface } from "../canvas/project-pdf-panel-surface";
import { SettingsDialogSurface } from "../settings/settings-dialog-surface";
import type { AppSurfaces } from "./app-surfaces";

/** The surfaces the shipped window renders; see app-surfaces.ts for why App does not import them itself. */
export const PRODUCTION_SURFACES: AppSurfaces = {
  documentCanvas: documentCanvasSurface,
  projectPdfPanel: projectPdfPanelSurface,
  settingsDialog: SettingsDialogSurface,
};
