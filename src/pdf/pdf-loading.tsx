import { useLingui } from "@lingui/react/macro";
import type { CSSProperties } from "react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { LoadingAnnouncement, useLoadingReveal } from "../components/ui/loading-status";
import { loadPdfViewPreference, type PdfFitMode } from "./pdf-viewer-utils";
import "./pdf-viewer.css";

/**
 * A PDF on its way: one indicator. The first load is a skeleton of the page
 * where the page will be; a refresh of a PDF already on screen is a small
 * "Updating…" status over it. Either waits a moment before it shows (see
 * loading-status.tsx), so a PDF that loads at once flashes neither.
 */
export function PdfLoading({ phase, percent = null, quiet = false, view }: {
  /** Fetching the bytes, or drawing the first page from them. */
  phase: "loading" | "rendering";
  percent?: number | null;
  /** A PDF is already on screen: say it is updating rather than draw a page over it. */
  quiet?: boolean;
  /** The fit and zoom the page will open at; the stored preference when the viewer has none yet. */
  view?: { fitMode: PdfFitMode; scale: number };
}) {
  const { t } = useLingui();
  if (quiet) return <PdfUpdating label={t`Updating…`} />;
  return (
    <>
      <PdfSkeletonPage view={view ?? loadPdfViewPreference()} percent={percent} />
      <LoadingAnnouncement message={phase === "loading" ? t`Loading PDF…` : t`Rendering first page…`} />
    </>
  );
}

function PdfUpdating({ label }: { label: string }) {
  const reveal = useLoadingReveal("pdf-update");
  return (
    <div className="pdf-loading pdf-loading-quiet loading-reveal" style={reveal} role="status" aria-live="polite">
      <InfinityLoader size={14} />
      <span>{label}</span>
    </div>
  );
}

/** Line widths (%) for the skeleton's two text columns, varied so they read as prose; 0 is a paragraph break. */
const COLUMNS = [
  [100, 94, 98, 88, 100, 62, 0, 96, 100, 91, 97, 70],
  [97, 100, 90, 100, 84, 0, 100, 95, 99, 87, 100, 58],
];

/** A US Letter page's width in CSS pixels at 100%: the size LaTeX's classes default to. */
const LETTER_WIDTH_PX = 612;

/**
 * A page-shaped placeholder at the first page's own place and size, measured
 * from the loaded viewer: inside the scroll area's border, at the top,
 * fitted to the width or the height as the page will be, or at its zoom.
 * The paper's size is not known before the PDF is, so it is Letter. Title,
 * authors, an abstract, two columns of text and a figure, with a sheen
 * passing over them; when the download's progress is known, a bar at the
 * page's head says how far it is.
 */
function PdfSkeletonPage({ view, percent }: { view: { fitMode: PdfFitMode; scale: number }; percent: number | null }) {
  const { t } = useLingui();
  const reveal = useLoadingReveal("pdf");
  const width = { "--pdf-skeleton-width": `${Math.round(LETTER_WIDTH_PX * view.scale)}px` } as CSSProperties;
  return (
    <div className="pdf-skeleton loading-reveal" data-fit={view.fitMode ?? "zoom"} style={{ ...reveal, ...width }} aria-hidden={percent === null || undefined}>
      <div className="pdf-skeleton-page loading-sheen">
        {percent !== null && (
          <div className="pdf-load-progress" role="progressbar" aria-label={t`PDF loading progress`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="pdf-load-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
        <span className="pdf-skeleton-title" />
        <span className="pdf-skeleton-title" data-short />
        <span className="pdf-skeleton-byline" />
        <div className="pdf-skeleton-abstract">
          {[100, 100, 100, 74].map((width, index) => <span key={index} style={{ width: `${width}%` }} />)}
        </div>
        <div className="pdf-skeleton-columns">
          {COLUMNS.map((lines, column) => (
            <div key={column}>
              {lines.map((width, index) => (
                <span key={index} data-gap={width === 0 || undefined} style={{ width: `${width}%` }} />
              ))}
            </div>
          ))}
        </div>
        <span className="pdf-skeleton-figure" />
        <div className="pdf-skeleton-columns">
          {COLUMNS.map((lines, column) => (
            <div key={column}>
              {[...lines].reverse().map((width, index) => <span key={index} data-gap={width === 0 || undefined} style={{ width: `${width}%` }} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
