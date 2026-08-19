import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile } from "remotion";
import { FPS } from "./constants";
import { PROMO_DURATION_IN_FRAMES, SCENE_STARTS } from "./film";

/**
 * Music and sound effects. No narration — the picture carries the story.
 *
 * The bed is a single track from the ElevenLabs Music API, written to run the
 * length of the film in one key and tempo. It replaces the three 30s
 * sound-generation loops used while the account was on the free tier: those had
 * to be cross-faded into each other at every chapter, and each handover was an
 * audible dip no matter how the fade was shaped.
 */

/** Cue points are "this scene, this many seconds in", so retiming a segment
 *  carries its sound with it instead of silently desyncing. */
const cue = (sceneKey: string, offsetSeconds: number) =>
  SCENE_STARTS[sceneKey] + Math.round(offsetSeconds * FPS);

/**
 * Offsets come from the SOURCE timestamp of the action divided by that
 * segment's playback rate — the compile lands at 3.2s of the capture and part
 * one runs at 1.2x, so it is 2.67s into the scene.
 */
const SFX: { file: string; at: number; volume: number; name: string }[] = [
  { name: "Riser", file: "riser", at: cue("title", 0.15), volume: 0.62 },
  // Part 1: PDF appears after the compile (src 3.2s), / menu opens (src 19.2s).
  { name: "Compile", file: "success", at: cue("p1-0", 2.67), volume: 0.4 },
  { name: "Slash menu", file: "pop", at: cue("p1-0", 16.0), volume: 0.9 },
  { name: "To Papers", file: "whoosh", at: cue("part2-title", 0.05), volume: 0.42 },
  // Part 2: the entry lands in the library (src 8.7s).
  { name: "Imported", file: "add", at: cue("p2-0", 4.85), volume: 0.4 },
  { name: "To Agent", file: "whoosh", at: cue("part3-title", 0.05), volume: 0.42 },
  // Part 3: prompt submitted (src 16.3s), canvas drawn (src 32.2s).
  { name: "Send", file: "send", at: cue("p3-0", 11.9), volume: 0.38 },
  { name: "Drawing", file: "draw", at: cue("p3-1", 2.5), volume: 0.42 },
  { name: "To Together", file: "whoosh", at: cue("part4-title", 0.05), volume: 0.42 },
  // Part 4: the second cursor arrives (src 3.8s), edits sync across (src 12.5s).
  { name: "Presence", file: "blip", at: cue("p4a-0", 3.24), volume: 0.36 },
  { name: "Sync", file: "tick", at: cue("p4b-0", 8.37), volume: 0.4 },
  { name: "Resolve", file: "resolve", at: cue("cta", 0.2), volume: 0.52 },
];

/** Loud enough to carry the pace, quiet enough that the UI stays the subject. */
const MUSIC_GAIN = 0.28;
const FADE_IN = 36;
const FADE_OUT = 96;

export const Soundtrack: React.FC = () => (
  <AbsoluteFill>
    <Sequence name="Music" durationInFrames={PROMO_DURATION_IN_FRAMES}>
      <Audio
        src={staticFile("audio/music.mp3")}
        // One continuous track, so the only shaping needed is a lift at the top
        // and a tail at the end.
        volume={(f) =>
          MUSIC_GAIN *
          Math.min(1, f / FADE_IN, (PROMO_DURATION_IN_FRAMES - f) / FADE_OUT)
        }
      />
    </Sequence>
    {SFX.map((sfx) => (
      <Sequence key={sfx.name} name={sfx.name} from={sfx.at}>
        <Audio
          src={staticFile(`audio/${sfx.file}.mp3`)}
          volume={() => sfx.volume}
        />
      </Sequence>
    ))}
  </AbsoluteFill>
);
