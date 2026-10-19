/**
 * The Overleaf picker's list while the connection is checked and the
 * projects load: the list's own group heading and two-line rows, at the
 * rows' measured height, as the one loading indicator. What is happening is
 * said to assistive technology only.
 */
import type { CSSProperties } from "react";
import { LoadingAnnouncement, useLoadingReveal } from "../components/ui/loading-status";

/** Name widths (%) of the placeholder rows, varied so they read as titles. */
const ROWS = [62, 44, 70, 52, 38];

/** The list's placeholder, inside the picker's list frame. */
export function ProjectSkeleton({ message }: { message: string }) {
  const reveal = useLoadingReveal("overleaf-projects");
  return (
    <>
      <div className="overleaf-skeleton loading-sheen loading-reveal" style={reveal} aria-hidden="true">
        <div className="overleaf-skeleton-heading"><span /></div>
        <ul>
          {ROWS.map((width, index) => (
            <li key={index} style={{ "--overleaf-skeleton-width": `${width}%` } as CSSProperties}>
              <span className="overleaf-skeleton-tile" />
              <span className="overleaf-skeleton-lines"><span /><span /></span>
            </li>
          ))}
        </ul>
      </div>
      <LoadingAnnouncement message={message} />
    </>
  );
}

/** The search and Show archived row, held while the connection is checked: a connected account's list opens under it. */
export function ProjectControlsSkeleton() {
  const reveal = useLoadingReveal("overleaf-projects");
  return <div className="overleaf-skeleton-controls loading-reveal" style={reveal} aria-hidden="true"><span /><span /></div>;
}
