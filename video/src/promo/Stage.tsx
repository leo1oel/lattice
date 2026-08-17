import { AbsoluteFill } from "remotion";
import { ACCENT, BG } from "./constants";

export interface StageProps {
  children?: React.ReactNode;
  /** Vertical origin of the accent wash. Off-frame for footage scenes so the
   *  card stays the brightest thing; behind the type on the text cards. */
  glowAt?: string;
}

/**
 * The one backdrop every scene sits on. Two very low-alpha washes rather than
 * one strong glow — a saturated halo behind a white app window reads as cheap,
 * and the eye should land on the UI, not the background.
 */
export const Stage: React.FC<StageProps> = ({ children, glowAt = "-22%" }) => (
  <AbsoluteFill style={{ backgroundColor: BG }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(135% 95% at 50% ${glowAt}, ${ACCENT}1c, transparent 68%)`,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(to bottom, rgba(0,0,0,0) 52%, rgba(0,0,0,0.42) 100%)",
      }}
    />
    {children}
  </AbsoluteFill>
);
