import { fade } from "@remotion/transitions/fade";
import { SectionCard } from "./Cards";
import { RECORDING_2_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { CUT_FRAMES, JUMP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part two — the paper library.
 *
 * Story: give it anything that points at a paper and everything else arrives —
 * the library entry, the alphaXiv write-up, the paper as Markdown, the PDF.
 *
 * Three segments, not six beats. Within a segment the recording runs unbroken;
 * the two joins are places where the edit genuinely skips ahead (past scrolling
 * back up, and past the return from the PDF), so a cut there shows new content
 * rather than replaying the last second.
 *
 * The Blog/Paper toggle flips at exactly 15.0s of the capture, so the write-up
 * caption has to be clear of that mark.
 */
const SEGMENTS: Beat[] = [
  {
    // Papers panel -> paste -> import -> alphaXiv write-up -> paper as Markdown.
    from: 2.4,
    to: 29.8,
    captions: [
      {
        at: 1.2,
        hold: 3.2,
        label: "Library",
        headline: "Add by arXiv link, title, or DOI",
      },
      {
        // Over the list entry and the "cite it with" toast. The .bib file
        // itself is never on screen, so it gets a mention and nothing more.
        at: 6.0,
        hold: 2.6,
        label: "Library",
        headline: "Imported — and added to your .bib",
      },
      {
        // Source 11.8-14.7 — clear of the 15.0s switch to the paper view.
        at: 9.4,
        hold: 2.9,
        label: "Blog",
        headline: "The alphaXiv write-up comes with it",
      },
      {
        at: 13.6,
        hold: 3.4,
        label: "Paper",
        headline: "The full paper, converted to Markdown",
      },
      {
        at: 17.6,
        hold: 3.4,
        label: "Agent-ready",
        headline: "Your agent can read it and edit it",
      },
      {
        // Late on purpose: Table 3 only scrolls in at ~26.5s of the source.
        at: 23.2,
        hold: 3.2,
        label: "Conversion",
        headline: "Figures, equations, and tables come through",
      },
    ],
  },
  {
    // The original PDF, one button away in the same tab.
    from: 31.6,
    to: 36.8,
    captions: [
      {
        at: 1.0,
        hold: 3.2,
        label: "Original PDF",
        headline: "The source PDF stays one click away",
      },
    ],
  },
  {
    // Split view: raw Markdown source beside the rendered paper, from 39.7.
    from: 39.3,
    to: 42.45,
    captions: [
      {
        at: 0.8,
        hold: 2.2,
        label: "Markdown",
        headline: "Source and render, side by side",
      },
    ],
  },
];

const SECTION_TITLE_FRAMES = 150;

export const partTwo = (): Section => ({
  scenes: [
    {
      key: "part2-title",
      duration: SECTION_TITLE_FRAMES,
      node: (
        <SectionCard
          title="Papers"
          subtitle="A link, a title — whatever you have."
        />
      ),
    },
    ...beatsToScenes(SEGMENTS, RECORDING_2_SRC, "p2"),
  ],
  transitions: [
    { frames: CUT_FRAMES, presentation: fade() as never },
    { frames: JUMP_FRAMES, presentation: fade() as never },
    { frames: JUMP_FRAMES, presentation: fade() as never },
  ],
});
