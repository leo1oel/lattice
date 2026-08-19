import { none } from "@remotion/transitions/none";
import { CtaCard } from "./Cards";
import { partFour } from "./partFour";
import { partOne } from "./partOne";
import { partThree } from "./partThree";
import { partTwo } from "./partTwo";
import { OVERLAP_FRAMES } from "./transitions";
import type { Section } from "./types";
import { joinSections, sceneStarts, sectionDuration } from "./types";

/**
 * The assembly, kept apart from the components that render it.
 *
 * Soundtrack.tsx needs SCENE_STARTS and Promo.tsx renders Soundtrack, so
 * holding the assembly in Promo.tsx made the two import each other — the cue
 * list ran at module scope before SCENE_STARTS existed and every render died
 * with "Cannot access 'SCENE_STARTS' before initialization".
 */
const CTA_FRAMES = 300;

const bridge = () => ({
  frames: OVERLAP_FRAMES,
  presentation: none() as never,
});

/** The outro belongs to the whole film, not to any one part, so it is appended
 *  here rather than inside a section. That keeps the part compositions usable
 *  as previews without rendering the full film every time. */
const withCta = (section: Section): Section =>
  joinSections(section, bridge(), {
    scenes: [
      {
        key: "cta",
        duration: CTA_FRAMES,
        node: <CtaCard />,
        motion: "recede",
        enter: 30,
        exit: 30,
      },
    ],
    transitions: [],
  });

/**
 * Each part runs straight into the next part's card — no recap, no flourish.
 * Replaying earlier features before starting a new topic only delays it.
 */
export const FULL: Section = withCta(
  joinSections(
    joinSections(joinSections(partOne(), bridge(), partTwo()), bridge(), partThree()),
    bridge(),
    partFour(),
  ),
);

export const PART_ONE: Section = partOne();
export const PART_TWO: Section = partTwo();
export const PART_THREE: Section = partThree();
export const PART_FOUR: Section = partFour();

export const PROMO_DURATION_IN_FRAMES = sectionDuration(FULL);
/** Where each scene of the finished film begins — the soundtrack hangs off this. */
export const SCENE_STARTS = sceneStarts(FULL);
export const PART_ONE_DURATION_IN_FRAMES = sectionDuration(PART_ONE);
export const PART_TWO_DURATION_IN_FRAMES = sectionDuration(PART_TWO);
export const PART_THREE_DURATION_IN_FRAMES = sectionDuration(PART_THREE);
export const PART_FOUR_DURATION_IN_FRAMES = sectionDuration(PART_FOUR);
