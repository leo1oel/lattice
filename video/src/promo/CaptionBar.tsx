import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { ACCENT_TEXT, FG } from "./constants";
import type { RevealStyle } from "./TextReveal";
import { TextReveal } from "./TextReveal";

export interface CaptionBarProps {
  label: string;
  headline: string;
  reveal: RevealStyle;
}

/**
 * Lower-third caption.
 *
 * The whole line arrives at once — see TextReveal. The wrapper adds the exit
 * and keeps the caption drifting the entire time it is up, so it is never
 * parked on screen.
 *
 * The scrim is not decoration: the app UI underneath is white and busy, and
 * dark caption text needs a calm field to sit on.
 */
export const CaptionBar: React.FC<CaptionBarProps> = ({
  label,
  headline,
  reveal,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  return (
    <AbsoluteFill
      style={{
        opacity: interpolate(
          frame,
          [0, 7, durationInFrames - 9, durationInFrames],
          [0, 1, 1, 0],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: [
              Easing.bezier(0.16, 1, 0.3, 1),
              Easing.linear,
              Easing.bezier(0.55, 0, 0.85, 0.35),
            ],
          },
        ),
        translate: interpolate(
          frame,
          [0, 9, durationInFrames],
          ["0px 8px", "0px 0px", "0px -10px"],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: [Easing.bezier(0.16, 1, 0.3, 1), Easing.linear],
          },
        ),
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 250,
          background:
            "linear-gradient(to top, rgba(246,246,249,0.97) 0%, rgba(246,246,249,0.88) 34%, rgba(246,246,249,0.5) 66%, rgba(246,246,249,0) 100%)",
        }}
      />
      <div
        style={{ position: "absolute", left: 0, right: 0, bottom: 104, height: 24 }}
      >
        <TextReveal
          text={label}
          style="fade"
          fontSize={18}
          color={ACCENT_TEXT}
          fontWeight={600}
          duration={6}
        />
      </div>
      <div
        style={{ position: "absolute", left: 0, right: 0, bottom: 46, height: 44 }}
      >
        <TextReveal
          text={headline}
          style={reveal}
          fontSize={31}
          color={FG}
          fontWeight={600}
          duration={8}
        />
      </div>
    </AbsoluteFill>
  );
};
