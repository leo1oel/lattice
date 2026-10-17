/**
 * The real compiled-project PDF panel for an App suite's `appHarness`. Importing this puts the panel in the
 * suite's import graph, so only the suites that test builds and the PDF do.
 */
// Keep the cold Vite transforms of the panel and its viewer outside interaction-test deadlines.
import "../canvas/project-pdf-panel";
import "../pdf/pdf-viewer";

export { projectPdfPanelSurface as projectPdfPanel } from "../canvas/project-pdf-panel-surface";
