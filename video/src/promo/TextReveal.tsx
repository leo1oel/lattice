import { Easing, interpolate, useCurrentFrame } from "remotion";
import { FONT_SANS } from "./constants";

/**
 * A whole line of text arriving at once.
 *
 * The remocn word-by-word reveals looked like a performance at this pace, so
 * fade / rise / scale still land the entire line together. `focus` is the
 * exception: remocn `tracking-in` (letter-spacing collapse + blur clear) on
 * a single brand word. Their copy springs with damping 18, which bounces;
 * this film does not bounce, so the same motion uses damping 200.
 */
export type RevealStyle = "fade" | "rise" | "scale" | "focus";

export interface TextRevealProps {
  text: string;
  style: RevealStyle;
  fontSize: number;
  color: string;
  fontWeight: number;
  /** Frames the line takes to arrive. */
  duration?: number;
  align?: "center" | "start";
  /** Initial letter-spacing in em for `focus`. Settles at `tracking`. */
  startTracking?: number;
  /** Settled letter-spacing in em. */
  tracking?: number;
  /** Initial blur in px for `focus`. */
  startBlur?: number;
  fontFamily?: string;
  fontVariationSettings?: string;
}

const EASE = Easing.bezier(0.16, 1, 0.3, 1);
const SETTLE = Easing.spring({ damping: 200 });

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  style,
  fontSize,
  color,
  fontWeight,
  duration = 8,
  align = "center",
  startTracking = 0.08,
  tracking = -0.02,
  startBlur = 8,
  fontFamily = FONT_SANS,
  fontVariationSettings,
}) => {
  const frame = useCurrentFrame();

  const shared = {
    position: "absolute" as const,
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: align === "start" ? ("flex-start" as const) : ("center" as const),
    fontSize,
    color,
    fontWeight,
    letterSpacing: `${tracking}em`,
    fontFamily,
    fontVariationSettings,
    whiteSpace: "nowrap" as const,
  };

  if (style === "focus") {
    return (
      <div
        style={{
          ...shared,
          letterSpacing: `${interpolate(frame, [0, duration], [startTracking, tracking], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: SETTLE,
          })}em`,
          filter: `blur(${interpolate(frame, [0, duration], [startBlur, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: SETTLE,
          })}px)`,
          opacity: interpolate(frame, [0, Math.min(16, duration)], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
          }),
        }}
      >
        {text}
      </div>
    );
  }

  if (style === "rise") {
    return (
      <div
        style={{
          ...shared,
          opacity: interpolate(frame, [0, duration], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
          }),
          translate: interpolate(frame, [0, duration], ["0px 14px", "0px 0px"], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
          }),
        }}
      >
        {text}
      </div>
    );
  }

  if (style === "scale") {
    return (
      <div
        style={{
          ...shared,
          opacity: interpolate(frame, [0, duration], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
          }),
          scale: interpolate(frame, [0, duration], [0.965, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
            output: "perceptual-scale",
          }),
        }}
      >
        {text}
      </div>
    );
  }

  return (
    <div
      style={{
        ...shared,
        opacity: interpolate(frame, [0, duration], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        }),
      }}
    >
      {text}
    </div>
  );
};
