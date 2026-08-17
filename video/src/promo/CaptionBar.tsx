import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BlurOutUp } from "../components/remocn/blur-out-up";
import { ACCENT_TEXT, FG } from "./constants";

export interface CaptionBarProps {
  label: string;
  headline: string;
}

/**
 * Lower-third caption. Must be mounted inside its own <Sequence>: BlurOutUp
 * reads `durationInFrames` from context to time its exit, so the sequence
 * length *is* the caption's lifetime.
 *
 * The scrim is not decoration — the app UI underneath is white, and white
 * caption text is unreadable over it without one. It is tall and soft rather
 * than short and opaque so the edge never reads as a band across the screen.
 */
export const CaptionBar: React.FC<CaptionBarProps> = ({ label, headline }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const scrim = interpolate(
    frame,
    [0, 14, durationInFrames - 16, durationInFrames],
    [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.33, 0, 0.15, 1),
    },
  );

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 250,
          opacity: scrim,
          background:
            "linear-gradient(to top, rgba(5,5,8,0.90) 0%, rgba(5,5,8,0.66) 34%, rgba(5,5,8,0.28) 66%, rgba(5,5,8,0) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 106,
          height: 24,
        }}
      >
        <BlurOutUp
          text={label}
          fontSize={18}
          color={ACCENT_TEXT}
          fontWeight={600}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 50,
          height: 42,
        }}
      >
        <BlurOutUp text={headline} fontSize={31} color={FG} fontWeight={600} />
      </div>
    </AbsoluteFill>
  );
};
