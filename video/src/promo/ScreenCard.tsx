import { Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";
import { BG, sec } from "./constants";

export interface ScreenCardProps {
  /** Filename inside public/. */
  src: string;
  /** Source timestamps in seconds. */
  from: number;
  to: number;
  /** Playback speed; the scene is sized to match in FeatureScene. */
  rate: number;
  /**
   * CSS `object-position`. The captures are not all the same shape, and
   * `cover` crops whatever does not fit:
   *
   * - 3244x2160 (parts 1-3) loses ~167px top and bottom — wallpaper only.
   * - 3528x2160 (Overleaf) loses ~88px — wallpaper only.
   * - 2880x2160 (share) is 4:3 and loses 540px. Centred, that eats the window
   *   title bar and toolbar, which is where the collaborator avatars live —
   *   the whole point of that clip. So it is anchored to the top instead and
   *   gives up empty spreadsheet rows at the bottom.
   */
  focus?: string;
}

/**
 * A run of the screen recording, full bleed.
 *
 * Deliberately static: the capture already carries its own camera zooms, and
 * SceneMotion is moving the whole screen underneath it. A third layer of
 * movement here would read as drift, not polish.
 */
export const ScreenCard: React.FC<ScreenCardProps> = ({
  src,
  from,
  to,
  rate,
  focus = "50% 50%",
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <Video
        name="Screen recording"
        src={staticFile(src)}
        trimBefore={sec(from)}
        trimAfter={sec(to)}
        playbackRate={rate}
        style={{ width: "100%", height: "100%", objectPosition: focus }}
        objectFit="cover"
      />
    </AbsoluteFill>
  );
};
