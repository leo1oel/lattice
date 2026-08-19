import { AbsoluteFill } from "remotion";
import { BG, ICON_BLUE, ICON_CYAN } from "./constants";

export interface StageProps {
  children?: React.ReactNode;
  /** Vertical origin of the accent wash. Off-frame for footage scenes so the
   *  recording stays the brightest thing; behind the type on the text cards. */
  glowAt?: string;
  /** Analog texture over the frame. On by default for graphic cards; footage
   *  scenes do not use Stage, so recordings keep their own grain. */
  grain?: boolean;
}

/** 160px tile, rasterized once and repeated. A full-frame feTurbulence
 *  re-filters 1280×720 every frame and made stills crawl. */
const GRAIN_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch" seed="2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`,
)}")`;

/**
 * The one backdrop every scene sits on. Two very low-alpha washes rather than
 * one strong tint — a saturated field behind a white app window reads as cheap,
 * and the eye should land on the UI, not the background. Blue and cyan are the
 * icon yarns, so the wash matches the mark instead of the old UI purple.
 *
 * A static grain overlay sits above the scene at ~3.5% multiply. remocn's
 * camera-lens / grain-gradient notes: analog texture is the cheapest way to
 * stop a frame looking like a CSS render. Intensity stays below the point
 * where 24px captions lose contrast.
 */
export const Stage: React.FC<StageProps> = ({
  children,
  glowAt = "-22%",
  grain = true,
}) => (
  <AbsoluteFill style={{ backgroundColor: BG }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 38% ${glowAt}, ${ICON_BLUE}26, transparent 68%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background: `radial-gradient(100% 80% at 64% ${glowAt}, ${ICON_CYAN}1f, transparent 64%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(to bottom, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 45%, rgba(17,17,20,0.06) 100%)",
      }}
    />
    {children}
    {grain ? (
      <AbsoluteFill
        style={{
          pointerEvents: "none",
          opacity: 0.035,
          mixBlendMode: "multiply",
          backgroundImage: GRAIN_TILE,
          backgroundSize: "160px 160px",
        }}
      />
    ) : null}
  </AbsoluteFill>
);
