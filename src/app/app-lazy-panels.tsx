/**
 * The panels App renders from chunks loaded on demand: the project file tree
 * and the paper library, the agent surface, and the build's diagnostics above
 * the PDF.
 */
import { lazy, memo } from "react";
import { lazyChunk } from "../lib/lazy-chunk";
import { loadPaperLibrary, loadProjectFileTree } from "./workspace-chunks";

// Lazy: the file tree pulls @pierre/trees (~270 KB), and neither sidebar
// panel renders on the Welcome screen, so they must not weigh down first paint.
// Memoized: their callbacks come through stable forwarders (useStableHandlers
// in use-panel-portals.tsx), so an editor keystroke does not re-render the file
// tree or the paper library.
export const ProjectFileTree = lazyChunk(loadProjectFileTree, (module) => memo(module.ProjectFileTree));
export const PaperLibrary = lazyChunk(loadPaperLibrary, (module) => memo(module.PaperLibrary));
export const TrellisAgentSurface = lazy(() => import("../trellis/trellis-agent-surface"));
export const CompileDiagnosticsPanel = lazy(() =>
  import("../build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
