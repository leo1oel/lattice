import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { CtaCard } from "./Cards";
import { partOne } from "./partOne";
import { partThree } from "./partThree";
import { partTwo } from "./partTwo";
import { CARD_CUT_FRAMES } from "./transitions";
import type { Section } from "./types";
import { joinSections, sectionDuration } from "./types";

const CTA_FRAMES = 240;

/** The outro belongs to the whole film, not to either part, so it is appended
 *  here rather than inside a section. That keeps PartOne/PartTwo usable as
 *  preview compositions without rendering the full film every time. */
const withCta = (section: Section): Section =>
  joinSections(
    section,
    { frames: CARD_CUT_FRAMES, presentation: fade() as never },
    {
      scenes: [{ key: "cta", duration: CTA_FRAMES, node: <CtaCard /> }],
      transitions: [],
    },
  );

const cardCut = () => ({
  frames: CARD_CUT_FRAMES,
  presentation: fade() as never,
});

/**
 * Each part runs straight into the next part's card — no recap, no flourish.
 * Replaying earlier features before starting a new topic only delays it.
 */
const FULL: Section = withCta(
  joinSections(
    joinSections(partOne(), cardCut(), partTwo()),
    cardCut(),
    partThree(),
  ),
);

const PART_ONE: Section = partOne();
const PART_TWO: Section = partTwo();
const PART_THREE: Section = partThree();

export const PROMO_DURATION_IN_FRAMES = sectionDuration(FULL);
export const PART_ONE_DURATION_IN_FRAMES = sectionDuration(PART_ONE);
export const PART_TWO_DURATION_IN_FRAMES = sectionDuration(PART_TWO);
export const PART_THREE_DURATION_IN_FRAMES = sectionDuration(PART_THREE);

const Series: React.FC<{ section: Section }> = ({ section }) => (
  <TransitionSeries
    style={{
      scale: 1.001,
    }}
  >
    {section.scenes.flatMap((scene, i) => {
      const nodes = [
        <TransitionSeries.Sequence
          key={scene.key}
          durationInFrames={scene.duration}
        >
          {scene.node}
        </TransitionSeries.Sequence>,
      ];
      const transition = section.transitions[i];
      if (transition) {
        nodes.push(
          <TransitionSeries.Transition
            key={`${scene.key}-transition`}
            presentation={transition.presentation}
            timing={linearTiming({ durationInFrames: transition.frames })}
          />,
        );
      }
      return nodes;
    })}
  </TransitionSeries>
);

export const Promo: React.FC = () => <Series section={FULL} />;
export const PartOne: React.FC = () => <Series section={PART_ONE} />;
export const PartTwo: React.FC = () => <Series section={PART_TWO} />;
export const PartThree: React.FC = () => <Series section={PART_THREE} />;
