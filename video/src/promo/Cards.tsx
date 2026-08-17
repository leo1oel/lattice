import { Sequence } from "remotion";
import { Drift } from "../components/remocn/drift";
import { MicroScaleFade } from "../components/remocn/micro-scale-fade";
import { SoftBlurIn } from "../components/remocn/soft-blur-in";
import { ACCENT_TEXT, CTA_URL, FG, MUTED } from "./constants";
import { Stage } from "./Stage";

/** A barely-perceptible push over the whole card — enough that the type never
 *  sits dead still, small enough that you cannot point at it. */
const GROW = 0.028;

export const TitleCard: React.FC = () => (
  <Stage glowAt="44%">
    <Drift grow={GROW}>
      <div
        style={{ position: "absolute", left: 0, right: 0, top: 262, height: 120 }}
      >
        <SoftBlurIn text="Lattice" fontSize={104} color={FG} fontWeight={600} />
      </div>
      <Sequence from={16}>
        <div
          style={{ position: "absolute", left: 0, right: 0, top: 398, height: 40 }}
        >
          <MicroScaleFade
            text="One project. Every kind of research file."
            fontSize={26}
            color={MUTED}
            fontWeight={500}
          />
        </div>
      </Sequence>
    </Drift>
  </Stage>
);

/** Chapter marker between parts. Smaller than the opening title so it reads as
 *  a section break rather than a second beginning. */
export const SectionCard: React.FC<{ title: string; subtitle: string }> = ({
  title,
  subtitle,
}) => (
  <Stage glowAt="46%">
    <Drift grow={GROW}>
      <div
        style={{ position: "absolute", left: 0, right: 0, top: 282, height: 90 }}
      >
        <SoftBlurIn text={title} fontSize={76} color={FG} fontWeight={600} />
      </div>
      <Sequence from={14}>
        <div
          style={{ position: "absolute", left: 0, right: 0, top: 390, height: 36 }}
        >
          <MicroScaleFade
            text={subtitle}
            fontSize={25}
            color={MUTED}
            fontWeight={500}
          />
        </div>
      </Sequence>
    </Drift>
  </Stage>
);

export const CtaCard: React.FC = () => (
  <Stage glowAt="42%">
    <Drift grow={GROW}>
      <div
        style={{ position: "absolute", left: 0, right: 0, top: 248, height: 100 }}
      >
        <SoftBlurIn text="Lattice" fontSize={88} color={FG} fontWeight={600} />
      </div>
      <Sequence from={14}>
        <div
          style={{ position: "absolute", left: 0, right: 0, top: 368, height: 40 }}
        >
          <MicroScaleFade
            text="Write, compute, and draw — in one project."
            fontSize={27}
            color={MUTED}
            fontWeight={500}
          />
        </div>
      </Sequence>
      {CTA_URL === null ? null : (
        <Sequence from={32}>
          <div
            style={{ position: "absolute", left: 0, right: 0, top: 436, height: 34 }}
          >
            <MicroScaleFade
              text={CTA_URL}
              fontSize={22}
              color={ACCENT_TEXT}
              fontWeight={600}
            />
          </div>
        </Sequence>
      )}
    </Drift>
  </Stage>
);
