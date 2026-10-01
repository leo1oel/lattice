/* eslint-disable lingui/no-unlocalized-strings -- SVG path data and element ids */
import { useId, type CSSProperties } from "react";
import "./welcome-lattice.css";

/*
 * The welcome screen's backdrop: the mark's lattice repeated as a faint field
 * of threads and knots, hollowed out behind the copy. Now and then a pulse
 * runs along a few threads to a knot that blooms — evidence finding its way
 * into the writing, which is what the screen's headline promises.
 *
 * The drawing is 1440 × 900 and slices to fill any window, so the knots stay
 * where the threads cross at every size. Grid point (m, n) sits at
 * (720 + 40m, 450 + 40n); with m + n even, those are exactly the crossings of
 * the two diagonal thread families below, 80 units apart along each axis.
 */
const WIDTH = 1440;
const HEIGHT = 900;
const STEP = 40;
const point = (m: number, n: number) => [WIDTH / 2 + STEP * m, HEIGHT / 2 + STEP * n] as const;

function threads(): string {
  const parts: string[] = [];
  // Rising threads (x + y constant) and falling ones (x − y constant), each
  // long enough to cross the whole drawing; the viewport clips them.
  for (let k = -16; k <= 16; k++) {
    const rise = WIDTH / 2 + HEIGHT / 2 + 2 * STEP * k;
    const fall = WIDTH / 2 - HEIGHT / 2 + 2 * STEP * k;
    parts.push(`M${rise + 100} -100L${rise - 1100} 1100`, `M${fall - 100} -100L${fall + 1100} 1100`);
  }
  return parts.join("");
}

function knots(): string {
  const parts: string[] = [];
  for (let m = -19; m <= 19; m++) {
    for (let n = -12; n <= 12; n++) {
      if ((m + n) % 2 !== 0) continue;
      const [x, y] = point(m, n);
      parts.push(`M${x} ${y}h0`);
    }
  }
  return parts.join("");
}

type Direction = "ne" | "se" | "sw" | "nw";
const MOVES: Record<Direction, [number, number]> = { ne: [1, -1], se: [1, 1], sw: [-1, 1], nw: [-1, -1] };

/** A pulse's path from a starting knot, one diagonal step per letter pair. */
function route(start: [number, number], steps: Direction[]) {
  let [m, n] = start;
  const points = [point(m, n)];
  for (const step of steps) {
    m += MOVES[step][0];
    n += MOVES[step][1];
    points.push(point(m, n));
  }
  const [x, y] = points[points.length - 1];
  return { d: `M${points.map(([px, py]) => `${px} ${py}`).join("L")}`, end: { x, y } };
}

/** Kept to the field's visible ring: clear of the hollow behind the copy and of the window edges. */
const ROUTES = [
  route([-15, -5], ["se", "se", "se", "ne", "ne", "se", "se"]),
  route([12, -8], ["sw", "sw", "se", "se", "se", "ne"]),
  route([-13, 6], ["ne", "ne", "se", "se", "se"]),
  route([14, 5], ["nw", "nw", "nw", "sw", "sw"]),
  route([-8, -10], ["se", "se", "ne", "ne", "se"]),
  route([6, 10], ["ne", "ne", "se", "se", "ne"]),
];
const THREADS = threads();
const KNOTS = knots();

export function WelcomeLattice() {
  const mask = `welcome-lattice${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      className="welcome-lattice"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* A luminance mask, not a color: black hides the field, white shows
            it. Hollow behind the copy, full in a ring around it, gone at the
            window's edges. */}
        <radialGradient id={`${mask}-fade`}>
          <stop offset="0" stopColor="#000" />
          <stop offset=".3" stopColor="#000" />
          <stop offset=".55" stopColor="#fff" />
          <stop offset=".82" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id={mask}>
          <rect width={WIDTH} height={HEIGHT} fill={`url(#${mask}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <path className="welcome-lattice-threads" d={THREADS} />
        <path className="welcome-lattice-knots" d={KNOTS} />
        {ROUTES.map(({ d, end }, index) => (
          <g
            key={d}
            className="welcome-lattice-route"
            data-thread={index % 2 ? "warp" : "weft"}
            style={{ "--route-order": index } as CSSProperties}
          >
            <path className="welcome-lattice-trail" d={d} pathLength={1} />
            <path className="welcome-lattice-pulse" d={d} pathLength={1} />
            <circle className="welcome-lattice-ring" cx={end.x} cy={end.y} r="4" />
            <circle className="welcome-lattice-bloom" cx={end.x} cy={end.y} r="3.5" />
          </g>
        ))}
      </g>
    </svg>
  );
}
