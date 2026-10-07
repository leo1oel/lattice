import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import "./pdf-viewer.css";

export function PdfLoading({ label, percent = null, quiet = false }: {
  label: string;
  percent?: number | null;
  quiet?: boolean;
}) {
  const { t } = useLingui();
  return (
    <>
      {!quiet && <PdfSkeletonPage />}
      <div className={`pdf-loading${quiet ? " pdf-loading-quiet" : ""}`} role="status" aria-live="polite">
        <InfinityLoader size={quiet ? 14 : 17} />
        <span>{label}</span>
        {percent !== null && <>
          <div className="pdf-load-progress" role="progressbar" aria-label={t`PDF loading progress`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <div className="pdf-load-progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <span className="pdf-load-percent" aria-hidden="true">{percent}%</span>
        </>}
      </div>
    </>
  );
}

/** Line widths (%) for the skeleton's two text columns, varied so they read as prose; 0 is a paragraph break. */
const COLUMNS = [
  [100, 94, 98, 88, 100, 62, 0, 96, 100, 91, 97, 70],
  [97, 100, 90, 100, 84, 0, 100, 95, 99, 87, 100, 58],
];

/**
 * A page-shaped placeholder behind the first load's status: title, authors,
 * an abstract, two columns of text and a figure, with a sheen passing over it.
 * It waits a moment before it shows, so a PDF that loads at once never
 * flashes it.
 */
function PdfSkeletonPage() {
  return (
    <div className="pdf-skeleton" aria-hidden="true">
      <div className="pdf-skeleton-page">
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
