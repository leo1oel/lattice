import { useId } from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import {
  ICON_BLUE,
  ICON_BLUE_LIGHT,
  ICON_CYAN,
  ICON_CYAN_DEEP,
} from "./constants";
import { Stage } from "./Stage";

/**
 * The app icon is three blue wefts and three cyan warps, rotated 45°, with
 * alternating over-under crossings — the same weave as
 * src-tauri/icons/app-icon.svg.
 *
 * Warps are split where they go under: a round cap on a crossing is a circle
 * inscribed in the intersection square, so the blue corners leak around it.
 * Butt-capped spans stop at the weft's edge and draw with a square leading
 * edge. Round caps exist only at the true ends of the yarn.
 *
 * Geometry is in the pre-rotation coordinate system (rotate 45° around 512).
 */
const SIZE = 1024;
const STROKE = 68;
const HALF = STROKE / 2;
const YARN_A = 250;
const YARN_B = 774;
const LANES = [336, 512, 688] as const;
const PLATE = { x: 42, y: 42, w: 940, h: 940, rx: 224 };

/** Same curve on weft and warp so one motion doesn't settle while the other
 *  is still starting. Slight ease-out, never in-out — in-out pauses at both
 *  ends, which read as a hitch in the middle of the weave. */
const YARN_EASE = Easing.bezier(0.32, 0.0, 0.18, 1);
const ENTER_EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** Tight stagger, warps overlapping wefts, so the loom never sits still. */
const WEFT = [
  { start: 6, dur: 36 },
  { start: 2, dur: 36 },
  { start: 6, dur: 36 },
] as const;

const WARP = [
  { start: 18, dur: 54 },
  { start: 24, dur: 54 },
  { start: 30, dur: 54 },
] as const;

/** Last warp finishes here. Title type arrives a few frames before this so
 *  the lockup forms as the yarns seat, not after a hold. */
export const KNIT_DURATION_FRAMES = WARP[2].start + WARP[2].dur;
export const KNIT_TITLE_AT = KNIT_DURATION_FRAMES - 16;

/**
 * Visible y-intervals of warp `i`, already gapped at every under-crossing.
 * The gap is exactly the weft's stroke, so the weft fills it with no halo.
 */
const WARP_SPANS: [number, number][][] = LANES.map((_, i) => {
  const spans: [number, number][] = [];
  let cursor = YARN_A;
  for (let j = 0; j < LANES.length; j++) {
    if ((i + j) % 2 !== 1) continue;
    const g0 = LANES[j] - HALF;
    const g1 = LANES[j] + HALF;
    if (g0 > cursor) spans.push([cursor, g0]);
    cursor = Math.max(cursor, g1);
  }
  if (cursor < YARN_B) spans.push([cursor, YARN_B]);
  return spans;
});

const weftProgress = (frame: number, j: number) =>
  interpolate(frame, [WEFT[j].start, WEFT[j].start + WEFT[j].dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: YARN_EASE,
  });

const warpProgress = (frame: number, i: number) =>
  interpolate(frame, [WARP[i].start, WARP[i].start + WARP[i].dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: YARN_EASE,
  });

export type LatticeKnitProps = {
  size?: number;
  /** The white rounded square of the app icon. */
  plate?: boolean;
};

export const LatticeKnit: React.FC<LatticeKnitProps> = ({
  size = 440,
  plate = true,
}) => {
  const frame = useCurrentFrame();
  const uid = useId().replace(/:/g, "");
  const blue = `${uid}-blue`;
  const cyan = `${uid}-cyan`;

  return (
    <div
      style={{
        width: size,
        height: size,
        opacity: interpolate(frame, [0, 8], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ENTER_EASE,
        }),
        scale: interpolate(frame, [0, KNIT_DURATION_FRAMES], [0.94, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.spring({ damping: 200 }),
          output: "perceptual-scale",
        }),
        filter: `drop-shadow(0 14px 16px rgba(17, 17, 20, ${interpolate(
          frame,
          [28, KNIT_DURATION_FRAMES],
          [0, 0.1],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: ENTER_EASE,
          },
        )}))`,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id={blue}
            x1="224"
            y1="512"
            x2="800"
            y2="512"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={ICON_BLUE} />
            <stop offset="1" stopColor={ICON_BLUE_LIGHT} />
          </linearGradient>
          <linearGradient
            id={cyan}
            x1="512"
            y1="224"
            x2="512"
            y2="800"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={ICON_CYAN} />
            <stop offset="1" stopColor={ICON_CYAN_DEEP} />
          </linearGradient>
          <linearGradient
            id={`${uid}-shine`}
            x1="512"
            y1="42"
            x2="512"
            y2="320"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#FFFFFF" stopOpacity="0.28" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
        </defs>
        {plate ? (
          <>
            <rect
              x={PLATE.x}
              y={PLATE.y}
              width={PLATE.w}
              height={PLATE.h}
              rx={PLATE.rx}
              fill="#FFFFFF"
            />
            <rect
              x={PLATE.x}
              y={PLATE.y}
              width={PLATE.w}
              height={PLATE.h}
              rx={PLATE.rx}
              fill={`url(#${uid}-shine)`}
            />
            <rect
              x={43}
              y={43}
              width={938}
              height={938}
              rx={223}
              stroke="#202124"
              strokeOpacity={0.08}
              strokeWidth={2}
            />
          </>
        ) : null}
        <g transform="rotate(45 512 512)">
          {LANES.map((y, j) => (
            <path
              key={`weft-${j}`}
              d={`M ${YARN_A} ${y} H ${YARN_B}`}
              stroke={`url(#${blue})`}
              strokeWidth={STROKE}
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - weftProgress(frame, j)}
            />
          ))}
          {LANES.map((x, i) => {
            const head = YARN_A + (YARN_B - YARN_A) * warpProgress(frame, i);
            return (
              <g key={`warp-${i}`}>
                {head > YARN_A ? (
                  <circle cx={x} cy={YARN_A} r={HALF} fill={`url(#${cyan})`} />
                ) : null}
                {WARP_SPANS[i].map(([a, b]) => {
                  const drawn =
                    head <= a ? 0 : head >= b ? 1 : (head - a) / (b - a);
                  if (drawn <= 0) return null;
                  return (
                    <path
                      key={`${a}-${b}`}
                      d={`M ${x} ${a} V ${b}`}
                      stroke={`url(#${cyan})`}
                      strokeWidth={STROKE}
                      strokeLinecap="butt"
                      pathLength={1}
                      strokeDasharray={1}
                      strokeDashoffset={1 - drawn}
                    />
                  );
                })}
                {head >= YARN_B ? (
                  <circle cx={x} cy={YARN_B} r={HALF} fill={`url(#${cyan})`} />
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};

/** Standalone preview: the icon on the film's stage, nothing else. */
export const KnitIconScene: React.FC = () => (
  <Stage glowAt="50%">
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <LatticeKnit />
    </div>
  </Stage>
);
