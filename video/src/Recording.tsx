import { Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";

/**
 * A raw capture, dropped in as-is so it can be scrubbed frame by frame in the
 * Studio while cutting. This is the tool for finding segment boundaries — the
 * point where a view actually changes is a frame, not a guess off a contact
 * sheet.
 *
 * The canvas is 1280x720 and the captures are 3:2, so they letterbox here.
 * That is fine: this composition is for reading timestamps, not for looking at.
 */
/** A type alias, not an interface: Remotion's `Composition` constrains props to
 *  `Record<string, unknown>`, and interfaces have no implicit index signature. */
export type RecordingProps = {
  src: string;
};

export const Recording: React.FC<RecordingProps> = ({ src }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      <Video
        name="Raw capture"
        src={staticFile(src)}
        style={{ width: "100%", height: "100%" }}
        objectFit="contain"
      />
    </AbsoluteFill>
  );
};
