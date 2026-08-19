import { none } from "@remotion/transitions/none";
import { SectionCard } from "./Cards";
import { RECORDING_3_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { OVERLAP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part three — the agent. The only cut is at 16.4s -> 29.2s, where the capture
 * sits for thirteen seconds streaming an answer and nothing moves on screen.
 * Everything either side of that plays continuously.
 *
 * The copy stays general: the agent holds the whole project, reads and writes
 * any file (.bib read-only), and the work on screen is one job among many.
 */
const SEGMENTS: Beat[] = [
  {
    from: 2.0,
    to: 16.4,
    rate: 1.2,
    captions: [
      {
        at: 3.6,
        hold: 3.0,
        label: "Agent",
        headline: "It has your whole project as context",
      },
      {
        at: 7.2,
        hold: 3.1,
        label: "Read and write",
        headline: "It can open and edit any file in it",
      },
      {
        at: 11.0,
        hold: 2.8,
        label: "Guardrail",
        headline: "Except your .bib — it cites, never edits",
      },
      {
        at: 13.9,
        hold: 1.9,
        label: "Any task",
        headline: "Ask in plain language, name a target",
      },
    ],
  },
  {
    from: 29.2,
    to: 40.3,
    rate: 1.2,
    captions: [
      {
        at: 30.0,
        hold: 4.4,
        label: "Any job",
        headline: "Write, rewrite, convert, redraw",
      },
      {
        at: 35.0,
        hold: 4.6,
        label: "In the project",
        headline: "The result is a file you keep editing",
      },
    ],
  },
];

const SECTION_TITLE_FRAMES = 180;

export const partThree = (): Section => ({
  scenes: [
    {
      key: "part3-title",
      duration: SECTION_TITLE_FRAMES,
      node: (
        <SectionCard
          title="Agent"
          subtitle="It reads your project, and writes to it."
          reveal="fade"
        />
      ),
      motion: "settle",
      enter: 26,
      exit: 30,
    },
    ...beatsToScenes(SEGMENTS, RECORDING_3_SRC, "p3", {
      revealFrom: 15,
      motions: ["swell", "rise"],
      enters: [24, 30],
      exits: [28, 24],
    }),
  ],
  transitions: [
    { frames: OVERLAP_FRAMES, presentation: none() as never },
    { frames: OVERLAP_FRAMES, presentation: none() as never },
  ],
});
