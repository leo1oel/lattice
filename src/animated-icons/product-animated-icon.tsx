import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { BakaiAnimatedIcon, type BakaiIconKind } from "./bakai-icons";
import { ProvidedAnimatedIcon, type ProvidedIconKind } from "./provided-icons";

type AnimatedProductIconProps = {
  kind: BakaiIconKind | ProvidedIconKind;
  source?: "bakai" | "provided";
  size?: number;
  converted?: boolean;
};

/**
 * Replays one icon gesture when its containing control is hovered or focused.
 * Playback remains mounted after pointer exit so an in-flight gesture can
 * finish at the exact static shape rather than snapping back midway.
 */
export function AnimatedProductIcon({
  kind,
  source = "bakai",
  size = 16,
  converted,
}: AnimatedProductIconProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [playId, setPlayId] = useState(0);
  const reducedMotion = useReducedMotion() ?? false;

  useEffect(() => {
    const control = hostRef.current?.parentElement;
    if (!control) return;
    const replay = () => setPlayId((current) => current + 1);
    control.addEventListener("pointerenter", replay);
    control.addEventListener("focus", replay);
    return () => {
      control.removeEventListener("pointerenter", replay);
      control.removeEventListener("focus", replay);
    };
  }, []);

  return (
    <span
      ref={hostRef}
      className={`animated-product-icon animated-product-icon--${kind}`}
      aria-hidden="true"
    >
      {source === "provided" ? (
        <ProvidedAnimatedIcon
          key={playId}
          kind={kind as ProvidedIconKind}
          size={size}
          playing={playId > 0}
          playId={playId}
          reducedMotion={reducedMotion}
        />
      ) : (
        <BakaiAnimatedIcon
          key={playId}
          kind={kind as BakaiIconKind}
          size={size}
          playing={playId > 0}
          playId={playId}
          reducedMotion={reducedMotion}
          converted={converted}
        />
      )}
    </span>
  );
}
