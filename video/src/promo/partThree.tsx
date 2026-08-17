import { fade } from "@remotion/transitions/fade";
import { SectionCard } from "./Cards";
import { RECORDING_3_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { CUT_FRAMES, JUMP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part three — the agent.
 *
 * Story: the agent reads a figure inside the paper and redraws it into a
 * different file in the same project, as real editable shapes.
 *
 * Two segments. The capture spends 16.3s to 29.2s streaming the answer, which
 * is the one stretch nothing happens in, so the edit jumps it. Everything else
 * runs unbroken.
 */
const SEGMENTS: Beat[] = [
  {
    // Reading the paper -> Agent panel -> prompt with the figure as context and
    // @attention-map.tldr as the target -> submit at 16.3s.
    from: 2.0,
    to: 16.3,
    captions: [
      {
        at: 1.2,
        hold: 3.0,
        label: "Agent",
        headline: "An agent that works inside the project",
      },
      {
        // A rule about the system rather than about this frame, so it stays a
        // single passing line — the .bib file is never on screen here.
        at: 4.8,
        hold: 3.0,
        label: "Guardrail",
        headline: "It can edit any file except your .bib",
      },
      {
        at: 8.4,
        hold: 3.0,
        label: "Context",
        headline: "Point it at a figure in the paper",
      },
      {
        // Source 13.6-16.0 — the "Files · attention-map.tldr" chip is up.
        at: 11.4,
        hold: 2.4,
        label: "Target",
        headline: "Name the file it should write to",
      },
    ],
  },
  {
    // The answer, then the canvas: the redrawn Vision Transformer figure.
    from: 29.2,
    to: 40.4,
    captions: [
      {
        at: 0.6,
        hold: 2.6,
        label: "Answer",
        headline: "It explains the figure in the panel",
      },
      {
        // Canvas is on screen from ~32s of the source.
        at: 4.5,
        hold: 3.2,
        label: "Canvas",
        headline: "And draws it into your canvas file",
      },
      {
        at: 8.0,
        hold: 2.2,
        label: "Editable",
        headline: "Boxes and arrows stay editable",
      },
    ],
  },
];

const SECTION_TITLE_FRAMES = 150;

export const partThree = (): Section => ({
  scenes: [
    {
      key: "part3-title",
      duration: SECTION_TITLE_FRAMES,
      node: (
        <SectionCard title="Agent" subtitle="It reads your project, and writes to it." />
      ),
    },
    ...beatsToScenes(SEGMENTS, RECORDING_3_SRC, "p3"),
  ],
  transitions: [
    { frames: CUT_FRAMES, presentation: fade() as never },
    { frames: JUMP_FRAMES, presentation: fade() as never },
  ],
});
