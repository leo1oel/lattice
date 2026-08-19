import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Whole-screen motion. This is the film's only transition system.
 *
 * **The transform is one straight line from the first frame to the last.** No
 * keyframes in the middle, so the speed never changes and the screen never
 * stops. An earlier version eased in, drifted, then eased out — and the drift
 * was ~29x slower than the entrance, so every scene visibly froze the moment it
 * arrived. Constant velocity is the only shape that cannot do that.
 *
 * Only opacity is eased, and only at the ends, because that is the transition:
 * neighbouring scenes overlap and cross-fade through their own envelopes, which
 * is why the `TransitionSeries` between them uses `none()`.
 *
 * Nothing springs, bounces or overshoots — the ends are plain ease-out/ease-in.
 */
export type MotionVariant = "settle" | "swell" | "rise" | "recede";

export interface SceneMotionProps {
  variant: MotionVariant;
  /** Frames the screen takes to fade in, and to fade out. */
  enter: number;
  exit: number;
  children: React.ReactNode;
}

const ENTER_EASE = Easing.bezier(0.16, 1, 0.3, 1);
const EXIT_EASE = Easing.bezier(0.55, 0, 0.85, 0.35);

/** Scale travelled per second of scene time. Constant across the film so a
 *  short scene and a long one move at the same visible speed.
 *
 * Every variant stays at or above scale 1.0 for its whole run. Anything below
 * 1.0 does not cover the canvas, and the composition background showed through
 * as a black strip along an edge whenever a scene scaled or translated past
 * its bounds. The cap also keeps the lower-third captions inside frame: at
 * 1280x720 a caption baseline sits ~314px off centre, so scale much beyond
 * 1.10 starts pushing it off the bottom.
 */
const TRAVEL_PER_SECOND = 0.022;
const TRAVEL_MIN = 0.03;
const TRAVEL_MAX = 0.055;
/** Extra scale the `rise` variant needs so its vertical travel stays covered. */
const RISE_HEADROOM = 0.06;
const RISE_SHIFT = 14;

export const SceneMotion: React.FC<SceneMotionProps> = ({
  variant,
  enter,
  exit,
  children,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();

  const travel = Math.min(
    TRAVEL_MAX,
    Math.max(TRAVEL_MIN, (durationInFrames / fps) * TRAVEL_PER_SECOND),
  );
  const span = [0, durationInFrames];

  const opacity = interpolate(
    frame,
    [0, enter, durationInFrames - exit, durationInFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: [ENTER_EASE, Easing.linear, EXIT_EASE],
    },
  );

  if (variant === "swell") {
    return (
      <AbsoluteFill
        style={{
          opacity,
          scale: interpolate(frame, span, [1, 1 + travel], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            output: "perceptual-scale",
          }),
        }}
      >
        {children}
      </AbsoluteFill>
    );
  }

  if (variant === "rise") {
    return (
      <AbsoluteFill
        style={{
          opacity,
          translate: interpolate(
            frame,
            span,
            [`0px ${RISE_SHIFT}px`, `0px ${-RISE_SHIFT}px`],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
          scale: interpolate(
            frame,
            span,
            [1 + RISE_HEADROOM + travel, 1 + RISE_HEADROOM],
            {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              output: "perceptual-scale",
            },
          ),
        }}
      >
        {children}
      </AbsoluteFill>
    );
  }

  if (variant === "recede") {
    return (
      <AbsoluteFill
        style={{
          opacity,
          scale: interpolate(frame, span, [1 + travel * 1.5, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            output: "perceptual-scale",
          }),
        }}
      >
        {children}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        opacity,
        scale: interpolate(frame, span, [1 + travel, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          output: "perceptual-scale",
        }),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
