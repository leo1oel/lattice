import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { BG, sec } from "./constants";

export interface ScreenCardProps {
  /** Filename inside public/ — the two recordings share the same geometry. */
  src: string;
  /** Source timestamps in seconds. */
  from: number;
  to: number;
}

/**
 * A run of the screen recording, full bleed.
 *
 * The captures are 3:2 and the canvas is 16:9, so `objectFit: cover` trims
 * ~167px off the top and bottom of the source. That was checked against the
 * widest and the most zoomed-in frames of both recordings: it takes desktop
 * wallpaper, never app chrome — the title bar and toolbar survive even in the
 * tightest shots.
 *
 * Deliberately static: the capture already carries its own camera zooms, and a
 * second layer of movement on top of them reads as drift, not polish.
 */
export const ScreenCard: React.FC<ScreenCardProps> = ({ src, from, to }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <OffthreadVideo
        src={staticFile(src)}
        trimBefore={sec(from)}
        trimAfter={sec(to)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
