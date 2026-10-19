import type { CSSProperties } from "react";
import { useLoadingReveal } from "../components/ui/loading-reveal";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { loadSplitRatio } from "../settings/app-settings";
import { SPLIT_MINIMUMS, splitGridTemplate } from "./use-split-layout";
import "./document-skeleton.css";

/** How a document is about to show: its source, its rendered page (Markdown, HTML), or both side by side. */
export type DocumentSkeletonShape = "source" | "page" | "split";

/**
 * Line widths (%) of the source's skeleton, varied so they read as text; 0 is
 * an empty line. Drawn in a loop, as many as the panel is tall.
 */
const SOURCE_LINES = [42, 30, 0, 26, 0, 96, 92, 98, 64, 0, 94, 97, 90, 99, 71, 0, 93, 98, 88, 52, 0];

/** The rendered page's blocks: a heading's width, or a paragraph's line widths. */
const PAGE_BLOCKS: ({ heading: number } | number[])[] = [
  { heading: 58 },
  [100, 97, 46],
  { heading: 40 },
  [99, 100, 95, 100, 62],
  [98, 100, 84],
  { heading: 34 },
  [100, 96, 100, 93, 100, 38],
  [97, 100, 71],
];

/**
 * A document on its way, drawn where it will be and at its size: the source
 * editor's gutter, lines and status bar, or the rendered page's column at
 * the reading measure, or both at the split the canvas keeps. Every document
 * loader shows this one shape, on the reveal clock of the "Opening…" overlay
 * (opening-overlay.tsx), so an open that passes from one to the next (the
 * overlay over the old document, a tab on its way to becoming active, the
 * visual editor's chunk, an HTML page's first load) is one indicator that
 * waits once, and a quick open shows nothing.
 */
export function DocumentSkeleton({ shape, label }: {
  shape: DocumentSkeletonShape;
  /** What is loading, for assistive technology. */
  label: string;
}) {
  const reveal = useLoadingReveal("opening");
  const split = shape === "split"
    ? { gridTemplateColumns: splitGridTemplate(SPLIT_MINIMUMS), "--split-ratio": loadSplitRatio() } as CSSProperties
    : undefined;
  return (
    <div className="document-skeleton" data-shape={shape} style={split}>
      {shape !== "page" && <SourceSkeleton reveal={reveal} />}
      {shape === "split" && <span className="document-skeleton-divider" />}
      {shape !== "source" && <PageSkeleton reveal={reveal} />}
      <LoadingAnnouncement message={label} />
    </div>
  );
}

function SourceSkeleton({ reveal }: { reveal: CSSProperties }) {
  return (
    <div className="document-skeleton-source">
      <div className="document-skeleton-lines loading-reveal" style={reveal} aria-hidden="true">
        <div className="loading-sheen">
          {Array.from({ length: 4 }, (_, round) => SOURCE_LINES.map((width, index) => (
            <span key={`${round}-${index}`} data-gap={width === 0 || undefined} style={{ width: `${width}%` }} />
          )))}
        </div>
      </div>
      {/* The live editor's status bar, empty, so the lines end where the editor's do. */}
      <div className="editor-status-bar" aria-hidden="true" />
    </div>
  );
}

function PageSkeleton({ reveal }: { reveal: CSSProperties }) {
  return (
    <div className="document-skeleton-page loading-reveal" style={reveal} aria-hidden="true">
      <div className="document-skeleton-column loading-sheen">
        {PAGE_BLOCKS.map((block, index) => (
          Array.isArray(block)
            ? (
              <p key={index}>
                {block.map((width, line) => <span key={line} style={{ width: `${width}%` }} />)}
              </p>
            )
            : <span key={index} className="document-skeleton-heading" style={{ width: `${block.heading}%` }} />
        ))}
      </div>
    </div>
  );
}
