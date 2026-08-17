import { fade } from "@remotion/transitions/fade";
import { TitleCard } from "./Cards";
import { RECORDING_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { CUT_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part one — the tour. One unbroken run of the recording, 0 to 47.45s.
 *
 * There are no cuts inside it on purpose. The capture is a single continuous
 * take, so an earlier version that sliced it into five beats had to overlap
 * their ranges to cover the dissolves — which played the same second of footage
 * twice, a beat apart, and read as the user repeating an action. Consecutive
 * moments of one shot belong to one scene; the captions supply the structure.
 *
 * Caption times are therefore absolute source seconds, which also makes them
 * easy to check against the recording.
 */
const SEGMENTS: Beat[] = [
  {
    from: 0,
    to: 47.45,
    captions: [
      {
        at: 1.8,
        hold: 4.0,
        label: "LaTeX",
        headline: "Local LaTeX, compiled automatically",
      },
      {
        at: 6.6,
        hold: 3.8,
        label: "Split view",
        headline: "Source and PDF, side by side",
      },
      {
        at: 12.7,
        hold: 4.0,
        label: "Markdown",
        headline: "Rich blocks over plain Markdown",
      },
      {
        at: 18.9,
        hold: 3.8,
        label: "Insert menu",
        headline: "Press / to insert any block",
      },
      {
        at: 25.0,
        hold: 4.0,
        label: "HTML",
        headline: "HTML renders live, right in the project",
      },
      {
        at: 31.6,
        hold: 4.0,
        label: "Canvas",
        headline: "Draw and explain on an infinite canvas",
      },
      {
        at: 35.6,
        hold: 3.2,
        label: "Ink",
        headline: "Annotate straight on the board",
      },
      {
        at: 41.4,
        hold: 4.2,
        label: "Sheets",
        headline: "Track experiment results in the project",
      },
    ],
  },
];

const TITLE_FRAMES = 180;

export const partOne = (): Section => ({
  scenes: [
    { key: "title", duration: TITLE_FRAMES, node: <TitleCard /> },
    ...beatsToScenes(SEGMENTS, RECORDING_SRC, "p1"),
  ],
  transitions: [{ frames: CUT_FRAMES, presentation: fade() as never }],
});
