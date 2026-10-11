import { type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./empty-illustration.css";

/*
 * Small line drawings for places with nothing in them yet. They share the
 * Lattice mark's vocabulary: neutral line work in the empty state's own
 * color, and one weft (blue) or warp (teal) thread that marks what will
 * arrive. Each draws itself in once when it appears and moves a little while
 * its empty state is hovered; nothing loops. Decorative only: the empty
 * state's text says what it means.
 */
export type EmptyIllustrationKind = "comments" | "search" | "history" | "done";

const order = (index: number) => ({ "--draw-order": index }) as CSSProperties;

/** A stroke that draws itself in, in sequence. */
function Line({ d, i, className }: { d: string; i: number; className?: string }) {
  return <path className={cn("empty-illustration-line", className)} d={d} pathLength={1} style={order(i)} />;
}

const SEARCH_PAGE = "M14 9.5a2.5 2.5 0 0 1 2.5-2.5h17a2.5 2.5 0 0 1 2.5 2.5v29a2.5 2.5 0 0 1-2.5 2.5h-17a2.5 2.5 0 0 1-2.5-2.5z";

function drawComments() {
  return (
    <>
      <Line d="M9 8h28a4 4 0 0 1 4 4v13a4 4 0 0 1-4 4H19l-6 5v-5H9a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4z" i={0} />
      <Line d="M11 15h20M11 21h12" i={1} className="empty-illustration-faint" />
      <path className="empty-illustration-paper" d="M27 20h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-4v5l-6-5H27a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z" />
      <Line d="M27 20h28a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4h-4v5l-6-5H27a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z" i={2} />
      <g className="empty-illustration-typing">
        <g style={order(3)}>
          <circle className="empty-illustration-knot" data-thread="weft" cx="34" cy="30" r="2" />
        </g>
        <g style={order(4)}>
          <circle className="empty-illustration-knot" data-thread="warp" cx="41" cy="30" r="2" />
        </g>
        <g style={order(5)}>
          <circle className="empty-illustration-knot" data-thread="weft" cx="48" cy="30" r="2" />
        </g>
      </g>
    </>
  );
}

function drawSearch() {
  // A page the lens has passed over and found nothing on. The page's lines
  // stop short of the lens, so its glass stays clear rather than cutting
  // through them; the lens ring carries the drawing's one thread.
  return (
    <>
      <path className="empty-illustration-paper" d={SEARCH_PAGE} />
      <Line d={SEARCH_PAGE} i={0} />
      <Line d="M18 14h12" i={1} className="empty-illustration-strong" />
      <Line d="M18 20h9M18 25h7M18 30h8M18 35h11" i={2} className="empty-illustration-faint" />
      <g className="empty-illustration-lens">
        <circle className="empty-illustration-paper" cx="38" cy="28" r="8" />
        <Line d="M38 20a8 8 0 1 1 0 16a8 8 0 1 1 0-16z" i={3} className="empty-illustration-weft" />
        <Line d="M43.75 33.75l6.75 6.75" i={4} className="empty-illustration-strong" />
      </g>
    </>
  );
}

function drawDone() {
  // A page with nothing left to fix: the same page as the search, with a
  // check in the warp where the lens would be.
  return (
    <>
      <path className="empty-illustration-paper" d={SEARCH_PAGE} />
      <Line d={SEARCH_PAGE} i={0} />
      <Line d="M18 14h12" i={1} className="empty-illustration-strong" />
      <Line d="M18 20h13M18 25h10M18 30h8M18 35h9" i={2} className="empty-illustration-faint" />
      <g className="empty-illustration-badge">
        <circle className="empty-illustration-paper" cx="40" cy="32" r="8" />
        <Line d="M40 24a8 8 0 1 1 0 16a8 8 0 1 1 0-16z" i={3} />
        <Line d="M36.5 32.25l2.5 2.5l4.75-5" i={4} className="empty-illustration-warp" />
      </g>
    </>
  );
}

function drawHistory() {
  return (
    <>
      <Line d="M18 8v34" i={0} className="empty-illustration-warp" />
      <circle className="empty-illustration-knot empty-illustration-now" cx="18" cy="12" r="3.5" style={order(1)} />
      <circle className="empty-illustration-knot" cx="18" cy="25" r="2.5" style={order(1.5)} />
      <circle className="empty-illustration-knot" cx="18" cy="38" r="2.5" style={order(2)} />
      <Line d="M27 12h22" i={2} className="empty-illustration-strong" />
      <Line d="M27 25h28M27 38h18" i={3} className="empty-illustration-faint empty-illustration-dashed" />
    </>
  );
}

const DRAWINGS: Record<EmptyIllustrationKind, () => ReactNode> = {
  comments: drawComments,
  search: drawSearch,
  history: drawHistory,
  done: drawDone,
};

export function EmptyIllustration({ kind, size = "default", className }: {
  kind: EmptyIllustrationKind;
  /** `compact` for dense panels and start-aligned lists. */
  size?: "compact" | "default";
  className?: string;
}) {
  return (
    <svg
      className={cn("empty-illustration", className)}
      data-kind={kind}
      data-size={size}
      viewBox="0 0 64 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {DRAWINGS[kind]()}
    </svg>
  );
}
