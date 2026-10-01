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
export type EmptyIllustrationKind = "papers" | "comments" | "search" | "history" | "preview";

const order = (index: number) => ({ "--draw-order": index }) as CSSProperties;

/** A stroke that draws itself in, in sequence. */
function Line({ d, i, className }: { d: string; i: number; className?: string }) {
  return <path className={cn("empty-illustration-line", className)} d={d} pathLength={1} style={order(i)} />;
}

const PAGE_BACK = "M14 9.5a2.5 2.5 0 0 1 2.5-2.5h19a2.5 2.5 0 0 1 2.5 2.5v29a2.5 2.5 0 0 1-2.5 2.5h-19a2.5 2.5 0 0 1-2.5-2.5z";
const PAGE_FRONT = "M24 11.5a2.5 2.5 0 0 1 2.5-2.5h19a2.5 2.5 0 0 1 2.5 2.5v29a2.5 2.5 0 0 1-2.5 2.5h-19a2.5 2.5 0 0 1-2.5-2.5z";

function drawPapers() {
  return (
    <>
      <g className="empty-illustration-sheet" data-part="back">
        <g transform="rotate(-9 26 24)">
          <path className="empty-illustration-paper" d={PAGE_BACK} />
          <Line d={PAGE_BACK} i={0} />
        </g>
      </g>
      <g className="empty-illustration-sheet" data-part="front">
        <g transform="rotate(5 36 26)">
          <path className="empty-illustration-paper" d={PAGE_FRONT} />
          <Line d={PAGE_FRONT} i={1} />
          <Line d="M29 17h14" i={2} className="empty-illustration-strong" />
          <Line d="M29 23h12M29 28h14M29 33h9" i={3} className="empty-illustration-faint" />
        </g>
      </g>
      <Line d="M47.5 31c5 0 6-9 10.5-11" i={4} className="empty-illustration-weft" />
      <circle className="empty-illustration-knot" data-thread="warp" cx="58.5" cy="19.5" r="2.5" style={order(5)} />
    </>
  );
}

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
  // A patch of lattice with one knot missing, and the lens that looked for it.
  const knots: Array<[number, number]> = [[10, 12], [22, 12], [34, 12], [10, 24], [22, 24], [10, 36], [22, 36], [34, 36]];
  return (
    <>
      <Line d="M10 12h24M10 24h24M10 36h24M10 12v24M22 12v24M34 12v24" i={0} className="empty-illustration-faint" />
      {knots.map(([x, y], index) => (
        <circle key={`${x}-${y}`} className="empty-illustration-knot" cx={x} cy={y} r="2" style={order(1 + index * 0.25)} />
      ))}
      <g className="empty-illustration-lens">
        <circle className="empty-illustration-paper" cx="38" cy="22" r="10" />
        <Line d="M38 12a10 10 0 1 1 0 20a10 10 0 1 1 0-20z" i={2} />
        <Line d="M45.5 29.5 54 38" i={3} className="empty-illustration-strong" />
        <Line d="M32 18.5a7 7 0 0 1 5-3.5" i={4} className="empty-illustration-weft" />
        <circle className="empty-illustration-missing" cx="34" cy="24" r="2.5" style={order(5)} />
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

function drawPreview() {
  return (
    <>
      <path className="empty-illustration-paper" d="M19 5h19l11 11v26a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" />
      <Line d="M19 5h19l11 11v26a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" i={0} />
      <Line d="M38 5v8a3 3 0 0 0 3 3h8" i={1} />
      <Line d="M22 20h14" i={2} className="empty-illustration-strong" />
      <Line d="M22 24h9" i={2.5} className="empty-illustration-weft" />
      <g className="empty-illustration-text">
        <Line d="M22 30h21" i={3} className="empty-illustration-faint" />
        <Line d="M22 34h21" i={3.3} className="empty-illustration-faint" />
        <Line d="M22 38h13" i={3.6} className="empty-illustration-faint" />
      </g>
    </>
  );
}

const DRAWINGS: Record<EmptyIllustrationKind, () => ReactNode> = {
  papers: drawPapers,
  comments: drawComments,
  search: drawSearch,
  history: drawHistory,
  preview: drawPreview,
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
