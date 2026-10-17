/**
 * The real document canvas for an App suite's `appHarness`. Importing this puts the canvas in the suite's
 * import graph, so only the suites that test documents do.
 */
// Keep the cold Vite transforms of the canvas and the lazy editors and viewer it mounts outside
// interaction-test deadlines; the tests still mount them, not doubles.
import "../canvas/document-canvas";
import "../editor/markdown/engine/lattice-visual-editor";
import "../pdf/pdf-viewer";

export { documentCanvasSurface as documentCanvas } from "../canvas/document-canvas-surface";
