import { none } from "@remotion/transitions/none";
import { SectionCard } from "./Cards";
import { RECORDING_OVERLEAF_SRC, RECORDING_SHARE_SRC } from "./constants";
import { beatsToScenes } from "./FeatureScene";
import { OVERLAP_FRAMES } from "./transitions";
import type { Beat, Section } from "./types";

/**
 * Part four — collaboration, from two captures, each played whole.
 *
 * `share.mp4` is 4:3 and anchored to the top of the frame: a centred crop eats
 * the toolbar, and the collaborator avatars there are the point of the shot.
 *
 * Overleaf copy is one-way on purpose: an Overleaf project opens here, not
 * the other way around. Sync covers edits, comments, and chat; Git is the
 * same working tree.
 */
const SHARE: Beat[] = [
  {
    from: 0.4,
    to: 6.35,
    rate: 1.05,
    focus: "50% 0%",
    captions: [
      {
        at: 1.0,
        hold: 2.4,
        label: "Share",
        headline: "Invite someone into the project",
      },
      {
        at: 3.9,
        hold: 2.2,
        label: "Presence",
        headline: "Their cursor and edits, as they happen",
      },
    ],
  },
];

const OVERLEAF: Beat[] = [
  {
    from: 1.2,
    to: 25.9,
    rate: 1.35,
    captions: [
      {
        at: 2.6,
        hold: 3.4,
        label: "Overleaf",
        headline: "Open an Overleaf project right here",
      },
      {
        at: 8.2,
        hold: 3.4,
        label: "Live",
        headline: "Edits, comments, and chat stay in sync",
      },
      {
        at: 14.4,
        hold: 3.2,
        label: "Git",
        headline: "The same files, under Git",
      },
    ],
  },
];

const SECTION_TITLE_FRAMES = 180;

export const partFour = (): Section => ({
  scenes: [
    {
      key: "part4-title",
      duration: SECTION_TITLE_FRAMES,
      node: (
        <SectionCard
          title="Collaboration"
          subtitle="Invite co-authors. Open Overleaf here."
          reveal="scale"
        />
      ),
      motion: "recede",
      enter: 28,
      exit: 24,
    },
    ...beatsToScenes(SHARE, RECORDING_SHARE_SRC, "p4a", {
      revealFrom: 22,
      motions: ["settle"],
      enters: [22],
      exits: [28],
    }),
    ...beatsToScenes(OVERLEAF, RECORDING_OVERLEAF_SRC, "p4b", {
      revealFrom: 25,
      motions: ["swell"],
      enters: [30],
      exits: [26],
    }),
  ],
  transitions: [
    { frames: OVERLAP_FRAMES, presentation: none() as never },
    { frames: OVERLAP_FRAMES, presentation: none() as never },
  ],
});
