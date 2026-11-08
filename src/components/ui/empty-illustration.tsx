import { type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./empty-illustration.css";

/*
 * Small line drawings for places with nothing in them yet. They share the
 * Lattice mark's vocabulary: neutral line work in the empty state's own
 * color, and one weft (olive) or warp (sage) thread that marks what will
 * arrive. Each draws itself in once when it appears and moves a little while
 * its empty state is hovered; nothing loops. Decorative only: the empty
 * state's text says what it means.
 */
export type EmptyIllustrationKind = "search" | "history" | "done";

const order = (index: number) => ({ "--draw-order": index }) as CSSProperties;

/** A stroke that draws itself in, in sequence. Drawings a lazy panel owns use it too. */
export function Line({ d, i, className }: { d: string; i: number; className?: string }) {
  return <path className={cn("empty-illustration-line", className)} d={d} pathLength={1} style={order(i)} />;
}

const SEARCH_PAGE = "M14 9.5a2.5 2.5 0 0 1 2.5-2.5h17a2.5 2.5 0 0 1 2.5 2.5v29a2.5 2.5 0 0 1-2.5 2.5h-17a2.5 2.5 0 0 1-2.5-2.5z";

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
