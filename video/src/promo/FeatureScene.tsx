import { AbsoluteFill, Sequence } from "remotion";
import { CaptionBar } from "./CaptionBar";
import { sec } from "./constants";
import { ScreenCard } from "./ScreenCard";
import type { Beat, Scene } from "./types";
import { REVEALS } from "./types";

export const FeatureScene: React.FC<{
  beat: Beat;
  src: string;
  /** Index into REVEALS for this segment's first caption. Threaded through so
   *  the cycle continues across segment boundaries and two captions either
   *  side of a cut never share a reveal. */
  revealFrom: number;
}> = ({ beat, src, revealFrom }) => (
  <AbsoluteFill>
    <ScreenCard
      src={src}
      from={beat.from}
      to={beat.to}
      rate={beat.rate}
      focus={beat.focus}
    />
    {beat.captions.map((caption, i) => (
      <Sequence
        key={`${caption.label}-${caption.at}`}
        name={caption.label}
        // `at` is an absolute source timestamp; sped-up footage reaches it
        // sooner, hence the divide by rate.
        from={Math.max(0, sec((caption.at - beat.from) / beat.rate))}
        durationInFrames={sec(caption.hold)}
      >
        <CaptionBar
          label={caption.label}
          headline={caption.headline}
          reveal={REVEALS[(revealFrom + i) % REVEALS.length]}
        />
      </Sequence>
    ))}
  </AbsoluteFill>
);

export const beatFrames = (beat: Beat) =>
  Math.round((sec(beat.to) - sec(beat.from)) / beat.rate);

/**
 * Turn segments into scenes, cycling both the caption reveals and the
 * screen-level motion so neighbours never repeat an animation.
 */
export const beatsToScenes = (
  beats: Beat[],
  src: string,
  keyPrefix: string,
  options: {
    revealFrom: number;
    motions: Scene["motion"][];
    enters: number[];
    exits: number[];
  },
): Scene[] => {
  let reveal = options.revealFrom;
  return beats.map((beat, i) => {
    const revealFrom = reveal;
    reveal += beat.captions.length;
    return {
      key: `${keyPrefix}-${i}`,
      duration: beatFrames(beat),
      motion: options.motions[i % options.motions.length],
      enter: options.enters[i % options.enters.length],
      exit: options.exits[i % options.exits.length],
      node: <FeatureScene beat={beat} src={src} revealFrom={revealFrom} />,
    };
  });
};
