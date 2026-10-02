import { motion, useAnimation } from "motion/react";
import { useEffect } from "react";

export type ProvidedIconKind = "cloud-upload-outline";

const SVG_PROPS = {
  fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", viewBox: "0 0 24 24", "aria-hidden": true,
} as const;

/** The user-selected Cloud Upload implementation. */
export function ProvidedAnimatedIcon({ size = 20, playing, playId, reducedMotion }: { size?: number; playing?: boolean; playId?: number; reducedMotion?: boolean }) {
  const controls = useAnimation();

  useEffect(() => {
    if (!playing || reducedMotion) return;
    void controls.start("initial");
    const timer = window.setTimeout(() => { void controls.start("active"); }, 320);
    return () => window.clearTimeout(timer);
  }, [controls, playId, playing, reducedMotion]);

  return (
    <motion.span
      className="provided-animated-icon"
      animate={playing && reducedMotion ? { opacity: [1, .35, 1] } : { opacity: 1 }}
      transition={{ duration: .7 }}
    >
      <div>
        <svg height={size} width={size} {...SVG_PROPS}>
          <path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
          <motion.g
            animate={controls}
            initial="active"
            transition={{ duration: .3, ease: [.68, -.6, .32, 1.6] }}
            variants={{ initial: { y: -2 }, active: { y: 0 } }}
          >
            <path d="M12 13v8" />
            <path d="m8 17 4-4 4 4" />
          </motion.g>
        </svg>
      </div>
    </motion.span>
  );
}
