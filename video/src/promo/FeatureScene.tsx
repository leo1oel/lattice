import { AbsoluteFill, Sequence } from "remotion";
import { CaptionBar } from "./CaptionBar";
import { sec } from "./constants";
import { ScreenCard } from "./ScreenCard";
import type { Beat, Scene, TransitionSpec } from "./types";

export const FeatureScene: React.FC<{ beat: Beat; src: string }> = ({
  beat,
  src,
}) => (
  <AbsoluteFill>
    <ScreenCard src={src} from={beat.from} to={beat.to} />
    {beat.captions.map((caption) => (
      <Sequence
        key={`${caption.label}-${caption.at}`}
        from={sec(caption.at)}
        durationInFrames={sec(caption.hold)}
      >
        <CaptionBar label={caption.label} headline={caption.headline} />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const beatFrames = (beat: Beat) => sec(beat.to) - sec(beat.from);

/** Turn a list of beats into scenes joined by one shared transition style. */
export const beatsToScenes = (
  beats: Beat[],
  src: string,
  keyPrefix: string,
): Scene[] =>
  beats.map((beat, i) => ({
    key: `${keyPrefix}-${i}`,
    duration: beatFrames(beat),
    node: <FeatureScene beat={beat} src={src} />,
  }));

export const repeatTransition = (
  count: number,
  make: () => TransitionSpec,
): TransitionSpec[] => Array.from({ length: count }, make);
