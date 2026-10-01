/* eslint-disable lingui/no-unlocalized-strings -- SVG path data and element ids */
import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import "./lattice-mark.css";

/*
 * The app icon's woven lattice (src-tauri/icons/app-icon.svg), drawn live so
 * it follows the theme and can move. Coordinates are the icon's own 1024 grid:
 * three weft threads run across, and the warp threads that cross them are
 * broken wherever they pass under a weft, which is what reads as a weave.
 */
const WEFT = [336, 512, 688];
/** Warp segments as [x, from y, to y], in the icon's draw order. */
const WARP: Array<[number, number, number]> = [
  [336, 250, 478], [336, 546, 774],
  [512, 250, 302], [512, 370, 654], [512, 722, 774],
  [688, 250, 478], [688, 546, 774],
];
const NODES: Array<[number, number]> = [[336, 250], [512, 250], [688, 250], [336, 774], [512, 774], [688, 774]];

/** A thread's place in the weave's sequence, which staggers its entrance. */
const order = (index: number) => ({ "--weave-order": index }) as CSSProperties;

export type LatticeMarkProps = {
  size?: number;
  /**
   * `weave` draws the threads in once, weft first, then lets a glint travel
   * the weft now and then. For moments (the welcome screen), never for
   * chrome that stays on screen while writing.
   */
  motion?: "none" | "weave";
  className?: string;
};

/** The Lattice mark. Decorative: it carries no name of its own. */
export function LatticeMark({ size = 24, motion = "none", className }: LatticeMarkProps) {
  // useId's punctuation is not safe inside `url(#…)`.
  const id = `lattice-mark${useId().replace(/[^\w-]/g, "")}`;
  const weft = `${id}-weft`;
  const warp = `${id}-warp`;
  return (
    <svg
      className={cn("lattice-mark", className)}
      data-motion={motion}
      width={size}
      height={size}
      viewBox="160 160 704 704"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={weft} x1="224" y1="512" x2="800" y2="512" gradientUnits="userSpaceOnUse">
          <stop className="lattice-mark-weft-from" />
          <stop offset="1" className="lattice-mark-weft-to" />
        </linearGradient>
        <linearGradient id={warp} x1="512" y1="224" x2="512" y2="800" gradientUnits="userSpaceOnUse">
          <stop className="lattice-mark-warp-from" />
          <stop offset="1" className="lattice-mark-warp-to" />
        </linearGradient>
      </defs>
      <g transform="rotate(45 512 512)">
        <g stroke={`url(#${weft})`} strokeWidth="68" strokeLinecap="round">
          {WEFT.map((y, index) => (
            <path key={y} className="lattice-mark-thread" pathLength={1} d={`M250 ${y}H774`} style={order(index)} />
          ))}
        </g>
        {/* Under the warp, so a glint passes beneath every crossing it should. */}
        {motion === "weave" && (
          <g className="lattice-mark-glints" strokeWidth="30" strokeLinecap="round">
            {WEFT.map((y, index) => (
              <path key={y} className="lattice-mark-glint" pathLength={1} d={`M250 ${y}H774`} style={order(index)} />
            ))}
          </g>
        )}
        <g stroke={`url(#${warp})`} strokeWidth="68" strokeLinecap="butt">
          {WARP.map(([x, from, to], index) => (
            <path
              key={`${x}-${from}`}
              className="lattice-mark-thread"
              pathLength={1}
              d={`M${x} ${from}V${to}`}
              style={order(WEFT.length + index)}
            />
          ))}
        </g>
        <g fill={`url(#${warp})`}>
          {NODES.map(([x, y], index) => (
            <circle key={`${x}-${y}`} className="lattice-mark-node" cx={x} cy={y} r="34" style={order(index)} />
          ))}
        </g>
      </g>
    </svg>
  );
}
