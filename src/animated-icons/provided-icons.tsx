import { motion, useAnimation, type Variants } from "motion/react";
import { useEffect } from "react";

export type ProvidedIconKind = "radio" | "cloud-upload-outline";

const SVG_PROPS = {
  fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", viewBox: "0 0 24 24", "aria-hidden": true,
} as const;

/** User-selected Radio and Cloud Upload implementations, with a duration scale added for lab review. */
export function ProvidedAnimatedIcon({ kind, size = 20, playing, playId, reducedMotion, speed = "normal" }: { kind: ProvidedIconKind; size?: number; playing?: boolean; playId?: number; reducedMotion?: boolean; speed?: "normal" | "slow" }) {
  const controls = useAnimation();
  const durationScale = speed === "slow" ? 1.9 : 1;

  useEffect(() => {
    if (!playing || reducedMotion) return;
    if (kind === "radio") {
      void controls.start("fadeOut").then(() => controls.start("fadeIn"));
      return;
    }
    void controls.start("initial");
    const timer = window.setTimeout(() => { void controls.start("active"); }, 320 * durationScale);
    return () => window.clearTimeout(timer);
  }, [controls, durationScale, kind, playId, playing, reducedMotion]);

  // The radio's outer bands (custom 1) restore after the inner ones (custom 0).
  const radioVariants: Variants = {
    fadeOut: { opacity: 0, transition: { duration: .3 * durationScale } },
    fadeIn: (i: number) => ({
      opacity: 1,
      transition: {
        type: "spring",
        stiffness: 300 / (durationScale * durationScale),
        damping: 20 / durationScale,
        delay: i * .1 * durationScale,
      },
    }),
  };
  const band = (d: string, custom: number) => (
    <motion.path animate={controls} custom={custom} d={d} initial={{ opacity: 1 }} variants={radioVariants} />
  );
  return (
    <motion.span
      className="provided-animated-icon"
      animate={playing && reducedMotion ? { opacity: [1, .35, 1] } : { opacity: 1 }}
      transition={{ duration: .7 * durationScale }}
    >
      <div>
        {kind === "radio" ? (
          <svg height={size} width={size} {...SVG_PROPS}>
            {band("M4.9 19.1C1 15.2 1 8.8 4.9 4.9", 1)}
            {band("M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5", 0)}
            <circle cx="12" cy="12" r="2" />
            {band("M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5", 0)}
            {band("M19.1 4.9C23 8.8 23 15.1 19.1 19", 1)}
          </svg>
        ) : (
          <svg height={size} width={size} {...SVG_PROPS}>
            <path d="M4.2 15.1A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2" />
            <motion.g
              animate={controls}
              initial="active"
              transition={{ duration: .3 * durationScale, ease: [.68, -.6, .32, 1.6] }}
              variants={{ initial: { y: -2 }, active: { y: 0 } }}
            >
              <path d="M12 13v8" />
              <path d="m8 17 4-4 4 4" />
            </motion.g>
          </svg>
        )}
      </div>
    </motion.span>
  );
}
