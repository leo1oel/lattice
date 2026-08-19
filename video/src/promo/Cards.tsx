import { Sequence } from "remotion";
import { ACCENT_TEXT, CTA_URL, FG, FONT_DISPLAY, MUTED, displayVars } from "./constants";
import { KNIT_TITLE_AT, LatticeKnit } from "./KnitIcon";
import { Stage } from "./Stage";
import { TextReveal } from "./TextReveal";

/**
 * The text cards. Whole lines, arriving fast — no word-by-word building.
 * Brand words and section titles are Fraunces; taglines stay Inter.
 * The opening brand word uses `focus` (tracking collapse): remocn
 * tracking-in without the bounce. SceneMotion moves the screen underneath.
 */
export const TitleCard: React.FC = () => (
  <Stage glowAt="44%">
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 268,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 24,
        }}
      >
        <Sequence name="Icon" layout="none">
          <LatticeKnit size={108} />
        </Sequence>
        <div style={{ willChange: "transform" }}>
          <div
            style={{
              position: "relative",
              width: 520,
              height: 108,
              overflow: "visible",
            }}
          >
            <Sequence from={KNIT_TITLE_AT} name="Title" layout="none">
              <TextReveal
                text="Lattice"
                style="focus"
                fontSize={96}
                color={FG}
                fontWeight={600}
                duration={48}
                align="start"
                startTracking={0.1}
                tracking={-0.01}
                startBlur={6}
                fontFamily={FONT_DISPLAY}
                fontVariationSettings={displayVars(96)}
              />
            </Sequence>
          </div>
          <div style={{ position: "relative", width: 560, height: 40, marginTop: 6 }}>
            <Sequence from={KNIT_TITLE_AT + 22} name="Tagline" layout="none">
              <TextReveal
                text="Everything your paper needs, in one place."
                style="rise"
                fontSize={24}
                color={MUTED}
                fontWeight={500}
                duration={16}
                align="start"
              />
            </Sequence>
          </div>
        </div>
      </div>
    </div>
  </Stage>
);

/** Chapter marker between parts. Smaller than the opening title so it reads as
 *  a section break rather than a second beginning. */
export const SectionCard: React.FC<{
  title: string;
  subtitle: string;
  reveal: "fade" | "rise" | "scale";
}> = ({ title, subtitle, reveal }) => (
  <Stage glowAt="46%">
    <div style={{ position: "absolute", left: 0, right: 0, top: 288, height: 90 }}>
      <TextReveal
        text={title}
        style={reveal}
        fontSize={72}
        color={FG}
        fontWeight={600}
        duration={10}
        tracking={-0.01}
        fontFamily={FONT_DISPLAY}
        fontVariationSettings={displayVars(72)}
      />
    </div>
    <Sequence from={7} name="Section subtitle">
      <div
        style={{ position: "absolute", left: 0, right: 0, top: 392, height: 36 }}
      >
        <TextReveal
          text={subtitle}
          style="fade"
          fontSize={24}
          color={MUTED}
          fontWeight={500}
          duration={8}
        />
      </div>
    </Sequence>
  </Stage>
);

export const CtaCard: React.FC = () => (
  <Stage glowAt="42%">
    <div style={{ position: "absolute", left: 0, right: 0, top: 248, height: 100 }}>
      <TextReveal
        text="Lattice"
        style="scale"
        fontSize={88}
        color={FG}
        fontWeight={600}
        duration={12}
        tracking={-0.01}
        fontFamily={FONT_DISPLAY}
        fontVariationSettings={displayVars(88)}
      />
    </div>
    <Sequence from={9} name="Outro line">
      <div
        style={{ position: "absolute", left: 0, right: 0, top: 368, height: 40 }}
      >
        <TextReveal
          text="Write, compute, and draw — in one project."
          style="rise"
          fontSize={27}
          color={MUTED}
          fontWeight={500}
          duration={9}
        />
      </div>
    </Sequence>
    {CTA_URL === null ? null : (
      <Sequence from={20} name="Outro URL">
        <div
          style={{ position: "absolute", left: 0, right: 0, top: 436, height: 34 }}
        >
          <TextReveal
            text={CTA_URL}
            style="fade"
            fontSize={22}
            color={ACCENT_TEXT}
            fontWeight={600}
            duration={8}
          />
        </div>
      </Sequence>
    )}
  </Stage>
);
