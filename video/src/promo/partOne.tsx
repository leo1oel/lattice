import { none } from "@remotion/transitions/none";
import { TitleCard } from "./Cards";
import { FormatsScene } from "./FormatsScene";
import { RECORDING_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { OVERLAP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part one — the tour, as ONE unbroken run of the take.
 *
 * A previous cut sliced this into six windows to hit a 60s target. Jump cuts
 * inside a single continuous screen recording read as stutter: the pointer
 * teleports and the camera move restarts. The capture is already a continuous
 * stream, so it plays as one, just faster than real time.
 *
 * Caption `at` values are absolute source timestamps.
 */
const SEGMENTS: Beat[] = [
  {
    from: 0,
    to: 47.45,
    rate: 1.2,
    captions: [
      {
        at: 3.0,
        hold: 3.5,
        label: "LaTeX",
        headline: "Local LaTeX, compiled automatically",
      },
      {
        at: 6.8,
        hold: 3.2,
        label: "Split view",
        headline: "Source and PDF, side by side",
      },
      {
        at: 13.0,
        hold: 3.4,
        label: "Markdown",
        headline: "Rich blocks over plain Markdown",
      },
      {
        at: 19.4,
        hold: 3.2,
        label: "Insert menu",
        headline: "Press / to insert any block",
      },
      {
        at: 25.4,
        hold: 3.4,
        label: "HTML",
        headline: "HTML renders live in the project",
      },
      {
        at: 31.8,
        hold: 5.6,
        label: "Canvas",
        headline: "Draw and explain on an infinite canvas",
      },
      {
        at: 41.4,
        hold: 3.4,
        label: "Sheets",
        headline: "Track experiment results in the project",
      },
    ],
  },
];

const TITLE_FRAMES = 240;

export const partOne = (): Section => ({
  scenes: [
    {
      key: "title",
      duration: TITLE_FRAMES,
      node: <TitleCard />,
      motion: "swell",
      enter: 30,
      exit: 24,
    },
    {
      // Establishing beat: every format the project holds, before the tour
      // demonstrates any of them.
      key: "formats",
      duration: 300,
      node: <FormatsScene />,
      motion: "rise",
      enter: 26,
      exit: 28,
    },
    ...beatsToScenes(SEGMENTS, RECORDING_SRC, "p1", {
      revealFrom: 0,
      motions: ["settle"],
      enters: [24],
      exits: [30],
    }),
  ],
  transitions: [
    { frames: OVERLAP_FRAMES, presentation: none() as never },
    { frames: OVERLAP_FRAMES, presentation: none() as never },
  ],
});
