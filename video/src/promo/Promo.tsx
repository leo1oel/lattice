import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { FULL, PART_FOUR, PART_ONE, PART_THREE, PART_TWO } from "./film";
import { SceneMotion } from "./SceneMotion";
import { Soundtrack } from "./Soundtrack";
import type { Section } from "./types";

export {
  PART_FOUR_DURATION_IN_FRAMES,
  PART_ONE_DURATION_IN_FRAMES,
  PART_THREE_DURATION_IN_FRAMES,
  PART_TWO_DURATION_IN_FRAMES,
  PROMO_DURATION_IN_FRAMES,
} from "./film";

/**
 * `none()` on every transition is deliberate: the scenes overlap so their own
 * SceneMotion envelopes cross, and nothing else draws a transition. See
 * transitions.ts.
 */
const Series: React.FC<{ section: Section }> = ({ section }) => (
  <TransitionSeries
    name="Film"
    style={{
      scale: 1.001,
    }}
  >
    {section.scenes.flatMap((scene, i) => {
      const nodes = [
        <TransitionSeries.Sequence
          key={scene.key}
          name={scene.key}
          durationInFrames={scene.duration}
        >
          <SceneMotion
            variant={scene.motion}
            enter={scene.enter}
            exit={scene.exit}
          >
            {scene.node}
          </SceneMotion>
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

/** Only the full film carries sound: the part previews start at frame 0 of
 *  their own section, so the cue frames would not line up. */
export const Promo: React.FC = () => (
  <>
    <Series section={FULL} />
    <Soundtrack />
  </>
);
export const PartOne: React.FC = () => <Series section={PART_ONE} />;
export const PartTwo: React.FC = () => <Series section={PART_TWO} />;
export const PartThree: React.FC = () => <Series section={PART_THREE} />;
export const PartFour: React.FC = () => <Series section={PART_FOUR} />;
