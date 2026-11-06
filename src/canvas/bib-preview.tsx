/**
 * A .bib file's reference list as the canvas shows it, alone in Preview or
 * beside its source in Split: the visual editor (its own chunk) over the
 * canvas's props, its edits and history steps handed back to the canvas.
 */
import { Suspense, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import type { EditorView } from "@codemirror/view";
import type { PaperSummary } from "../app-types";
import type { DocumentCanvasProps } from "./canvas-model";
import { BibVisualEditor, MarkdownPreviewLoading } from "./canvas-lazy-editors";

const NO_PAPERS: PaperSummary[] = [];

export function BibPreview({ canvas, path, sourceView, cursorRef, onChange, onUndo, onRedo, onActivate }: {
  canvas: DocumentCanvasProps;
  path: string;
  /** The source editor beside the list, in Split; the list follows its cursor and marks its own clicks there. */
  sourceView: EditorView | null | undefined;
  /** The slot the source editor's every update calls. */
  cursorRef: RefObject<(() => void) | null>;
  onChange: (next: string, base: string) => boolean;
  onUndo: () => boolean;
  onRedo: () => boolean;
  /** The list was pointed at or focused: it is the surface the context follows. */
  onActivate: () => void;
}) {
  const { t } = useLingui();
  const { document, bibliography } = canvas;
  return (
    <div className="bib-preview" onPointerDownCapture={onActivate} onFocusCapture={onActivate}>
      <Suspense fallback={<MarkdownPreviewLoading />}>
        <BibVisualEditor
          path={path}
          source={document.source}
          projectRoot={canvas.preferences.projectRoot}
          editable={document.editorEditable}
          papers={bibliography.papers ?? NO_PAPERS}
          paperFetchStates={bibliography.paperFetchStates}
          sourceView={sourceView}
          cursorRef={cursorRef}
          usageRevision={bibliography.citationUsageRevision}
          onChange={onChange}
          onUndo={onUndo}
          onRedo={onRedo}
          onOpenLine={(file, line) => canvas.navigation.onTexlabGoto(file, line)}
          onOpenPaper={(paper) => bibliography.onOpenPaper?.(paper)}
          onOpenUrl={(url) => bibliography.onOpenUrl?.(url)}
          onResolveCitation={(query) => bibliography.onResolveCitation?.(query) ?? Promise.reject(new Error(t`Looking up references is not available here.`))}
        />
      </Suspense>
    </div>
  );
}
