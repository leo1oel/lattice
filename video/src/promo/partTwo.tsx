import { none } from "@remotion/transitions/none";
import { SectionCard } from "./Cards";
import { RECORDING_2_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { OVERLAP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/** Part two — the paper library, one continuous run. The Blog/Paper toggle
 *  flips at 15.0s of the capture, so the write-up caption clears before it. */
const SEGMENTS: Beat[] = [
  {
    from: 2.4,
    to: 42.4,
    rate: 1.3,
    captions: [
      {
        at: 4.5,
        hold: 3.4,
        label: "Library",
        headline: "Add by arXiv link, title, or DOI",
      },
      {
        at: 8.8,
        hold: 3.0,
        label: "BibTeX",
        headline: "Imported, with its citekey",
      },
      {
        at: 12.4,
        hold: 1.9,
        label: "Blog",
        headline: "The alphaXiv write-up too",
      },
      {
        at: 16.6,
        hold: 3.4,
        label: "Paper",
        headline: "The paper as Markdown, agent-ready",
      },
      {
        at: 24.0,
        hold: 3.2,
        label: "Conversion",
        headline: "Figures, equations, and tables come through",
      },
      {
        at: 33.0,
        hold: 3.0,
        label: "Original PDF",
        headline: "The source PDF, one click away",
      },
      {
        at: 40.2,
        hold: 2.4,
        label: "Markdown",
        headline: "Source and render, side by side",
      },
    ],
  },
];

const SECTION_TITLE_FRAMES = 180;

export const partTwo = (): Section => ({
  scenes: [
    {
      key: "part2-title",
      duration: SECTION_TITLE_FRAMES,
      node: (
        <SectionCard
          title="Papers"
          subtitle="A link, a title — whatever you have."
          reveal="rise"
        />
      ),
      motion: "rise",
      enter: 28,
      exit: 22,
    },
    ...beatsToScenes(SEGMENTS, RECORDING_2_SRC, "p2", {
      revealFrom: 8,
      motions: ["recede"],
      enters: [30],
      exits: [26],
    }),
  ],
  transitions: [{ frames: OVERLAP_FRAMES, presentation: none() as never }],
});
