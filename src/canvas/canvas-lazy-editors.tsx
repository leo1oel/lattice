import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { lazyChunk } from "../lib/lazy-chunk";
import { PdfLoading } from "../pdf/pdf-loading";
import { DocumentSkeleton } from "./document-skeleton";
import {
  isVisualMarkdownEditorWarmed, loadBibVisualEditorModule, loadBoardEditorModule, loadOpenSlideWorkspaceModule,
  loadPdfPreviewModule, loadSpreadsheetEditorModule, loadVisualMarkdownEditorModule,
  markVisualMarkdownEditorWarmed,
} from "./canvas-lazy-modules";

/** The canvas's heavy editors, each behind its own chunk (see canvas-lazy-modules). */
export const PdfPreview = lazyChunk(loadPdfPreviewModule, (module) => module.PdfPreview);
const VisualMarkdownEditor = lazyChunk(loadVisualMarkdownEditorModule, (module) => module.LatticeVisualMarkdownEditor);
export const BoardEditor = lazyChunk(loadBoardEditorModule, (module) => module.BoardEditor);
export const SpreadsheetEditor = lazyChunk(loadSpreadsheetEditorModule, (module) => module.SpreadsheetEditor);
export const OpenSlideWorkspace = lazyChunk(loadOpenSlideWorkspaceModule, (module) => module.OpenSlideWorkspace);
export const BibVisualEditor = lazyChunk(loadBibVisualEditorModule, (module) => module.BibVisualEditor);

export function DeferredVisualMarkdownEditor(props: ComponentProps<typeof VisualMarkdownEditor>) {
  const { t } = useLingui();
  const [ready, setReady] = useState(isVisualMarkdownEditorWarmed);
  useEffect(() => {
    if (ready) {
      markVisualMarkdownEditorWarmed();
      return;
    }
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);
  if (!ready) {
    return <DocumentSkeleton shape="page" label={t`Preparing Markdown editor`} />;
  }
  return <VisualMarkdownEditor {...props} />;
}

/** The PDF viewer's frame before a document shows: `toolbar` fills its bar, `children` replaces the spinner. */
export function PdfPreviewLoading({ toolbar, children }: { toolbar?: ReactNode; children?: ReactNode }) {
  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar-frame">
        <div className="pdf-toolbar">{toolbar}</div>
      </div>
      <div className="pdf-scroll-area">
        {children ?? <PdfLoading phase="loading" />}
      </div>
    </div>
  );
}

/** A rendered page (a Markdown file's, a bibliography's reference list) whose editor's chunk is on its way. */
export function MarkdownPreviewLoading() {
  const { t } = useLingui();
  return <DocumentSkeleton shape="page" label={t`Preparing preview…`} />;
}

/** An HTML file's page before its preview may run (see DocumentCanvas's interactivePreviewsEnabled). */
export function HtmlPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="html-preview">
      <DocumentSkeleton shape="page" label={t`Preparing HTML preview…`} />
    </div>
  );
}
