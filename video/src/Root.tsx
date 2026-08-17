import { Composition } from "remotion";
import {
  FPS,
  HEIGHT,
  RECORDING_2_FRAMES,
  RECORDING_2_SRC,
  RECORDING_3_FRAMES,
  RECORDING_3_SRC,
  RECORDING_FRAMES,
  RECORDING_SRC,
  WIDTH,
} from "./promo/constants";
import {
  PART_ONE_DURATION_IN_FRAMES,
  PART_THREE_DURATION_IN_FRAMES,
  PART_TWO_DURATION_IN_FRAMES,
  PartOne,
  PartThree,
  PartTwo,
  Promo,
  PROMO_DURATION_IN_FRAMES,
} from "./promo/Promo";
import { Recording } from "./Recording";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* The film: part one, part two, and the shared outro. */}
      <Composition
        id="Promo"
        component={Promo}
        durationInFrames={PROMO_DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* Section previews, so iterating on one part doesn't mean rendering
          the whole film each time. Neither carries the outro. */}
      <Composition
        id="PartOne-Tour"
        component={PartOne}
        durationInFrames={PART_ONE_DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="PartTwo-Papers"
        component={PartTwo}
        durationInFrames={PART_TWO_DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Composition
        id="PartThree-Agent"
        component={PartThree}
        durationInFrames={PART_THREE_DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      {/* The raw captures, kept registered so beat boundaries can be read off
          the timeline frame by frame while re-cutting. */}
      <Composition
        id="Raw-Tour"
        component={Recording}
        durationInFrames={RECORDING_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ src: RECORDING_SRC }}
      />
      <Composition
        id="Raw-Papers"
        component={Recording}
        durationInFrames={RECORDING_2_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ src: RECORDING_2_SRC }}
      />
      <Composition
        id="Raw-Agent"
        component={Recording}
        durationInFrames={RECORDING_3_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ src: RECORDING_3_SRC }}
      />
    </>
  );
};
