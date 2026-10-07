import { lazy, useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { FileCode2 } from "lucide-react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { PdfLoading } from "../pdf/pdf-loading";
import {
  isVisualMarkdownEditorWarmed, loadBoardEditorModule, loadOpenSlideWorkspaceModule,
  loadPdfPreviewModule, loadProofreadDiffModule, loadSpreadsheetEditorModule, loadVisualMarkdownEditorModule,
  markVisualMarkdownEditorWarmed,
} from "./canvas-lazy-modules";

/** The canvas's heavy editors, each behind its own chunk (see canvas-lazy-modules). */
export const PdfPreview = lazy(() => loadPdfPreviewModule().then((module) => ({ default: module.PdfPreview })));
const VisualMarkdownEditor = lazy(() => loadVisualMarkdownEditorModule().then((module) => ({ default: module.LatticeVisualMarkdownEditor })));
export const BoardEditor = lazy(() => loadBoardEditorModule().then((module) => ({ default: module.BoardEditor })));
export const SpreadsheetEditor = lazy(() => loadSpreadsheetEditorModule().then((module) => ({ default: module.SpreadsheetEditor })));
export const OpenSlideWorkspace = lazy(() => loadOpenSlideWorkspaceModule().then((module) => ({ default: module.OpenSlideWorkspace })));
export const ProofreadDiff = lazy(() => loadProofreadDiffModule().then((module) => ({ default: module.ProofreadDiff })));

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
    return <div className="visual-markdown-preparing" aria-busy="true" aria-label={t`Preparing Markdown editor`} />;
  }
  return <VisualMarkdownEditor {...props} />;
}

/** The PDF viewer's frame before a document shows: `toolbar` fills its bar, `children` replaces the spinner. */
export function PdfPreviewLoading({ toolbar, children }: { toolbar?: ReactNode; children?: ReactNode }) {
  const { t } = useLingui();
  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar-frame">
        <div className="pdf-toolbar">{toolbar}</div>
      </div>
      <div className="pdf-scroll-area">
        {children ?? <PdfLoading label={t`Loading PDF…`} />}
      </div>
    </div>
  );
}

export function MarkdownPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="markdown-preview-loading" role="status" aria-live="polite">
      <InfinityLoader size={20} />
      <span>{t`Preparing preview…`}</span>
    </div>
  );
}

export function HtmlPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="html-preview">
      <div className="pdf-placeholder">
        <FileCode2 size={28} />
        <p>{t`Preparing HTML preview…`}</p>
      </div>
    </div>
  );
}
