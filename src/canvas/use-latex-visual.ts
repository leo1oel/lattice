/**
 * Keeps the mounted source editor of a .tex file in the view the writer chose
 * for it, Source or Visual, and tells Visual mode when the project data it
 * draws from changes (see latex-visual-switch.ts). The writer's choice is
 * latex-view-choice.ts. Little else: the canvas renders on every keystroke,
 * and this runs with it.
 */
import { useEffect, useLayoutEffect, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { isLatexDocumentPath, latexView, useLatexView } from "../editor/latex/latex-view-choice";
import { latexVisualDataChanged, setLatexVisual, type LatexVisualHost } from "../editor/latex/latex-visual-switch";
import type { DocumentCanvasProps } from "./canvas-model";
import { editorLiveData, type SourceSessionLive } from "./source-session";

/** Whether `path` draws in Visual mode: a .tex file, while the writer has chosen Visual for them. */
const wantsVisual = (path: string) => latexView() === "visual" && isLatexDocumentPath(path);

/** One host per canvas (its `live` getters are fixed for the canvas's life); everything it gives is read when Visual draws. */
const hosts = new WeakMap<SourceSessionLive, LatexVisualHost>();
function hostFor(live: SourceSessionLive): LatexVisualHost {
  let host = hosts.get(live);
  if (!host) {
    const data = editorLiveData(live);
    host = {
      data: () => data.current,
      loadImage: (imagePath) => live.props().bibliography.onLoadReferenceImage(imagePath),
      open: (target) => live.props().navigation.onGotoDefinition(target),
    };
    hosts.set(live, host);
  }
  return host;
}

export function useLatexVisual(
  props: DocumentCanvasProps,
  live: SourceSessionLive,
  viewRef: RefObject<EditorView | null>,
  /** The mounted view, as state, so a new one (another document, a remount) is switched too. */
  view: WeakRef<EditorView> | null,
) {
  const visual = useLatexView() === "visual" && isLatexDocumentPath(props.document.activeFile);
  // Before paint, so a document that opens in Visual is never seen as its source first (once the module is in).
  useLayoutEffect(() => {
    const current = view?.deref();
    if (!current || current !== viewRef.current) return;
    setLatexVisual(current, visual, hostFor(live), () => viewRef.current === current && wantsVisual(live.props().document.activeFile));
  }, [live, view, viewRef, visual]);

  const { katexMacros, compiledBuild, citations, references, projectPaths, graphicsRoots, rootDocumentPath } = props.bibliography;
  useEffect(() => {
    viewRef.current?.dispatch({ effects: latexVisualDataChanged.of(null) });
  }, [katexMacros, compiledBuild, citations, references, projectPaths, graphicsRoots, rootDocumentPath, viewRef]);
}
