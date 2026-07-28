import type { Variants } from "motion/react";
import { motion, useAnimation } from "motion/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, type HTMLAttributes } from "react";

export type ProvidedIconKind = "radio" | "cloud-upload-outline";

export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
  durationScale?: number;
}

/** User-selected Radio implementation, with only a duration scale added for lab review. */
export const RadioIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, durationScale = 1, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);
    const variants = useMemo<Variants>(() => ({
      normal: { opacity: 1, transition: { duration: .4 * durationScale } },
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
    }), [durationScale]);

    const startAnimation = useCallback(() => {
      void controls.start("fadeOut").then(() => controls.start("fadeIn"));
    }, [controls]);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return { startAnimation, stopAnimation: () => { void controls.start("normal"); } };
    }, [controls, startAnimation]);

    return (
      <div
        className={className}
        onMouseEnter={(event) => {
          if (!isControlledRef.current) startAnimation();
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          if (!isControlledRef.current) void controls.start("normal");
          onMouseLeave?.(event);
        }}
        {...props}
      >
        <svg fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width={size} aria-hidden="true">
          <motion.path animate={controls} custom={1} d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" initial={{ opacity: 1 }} variants={variants} />
          <motion.path animate={controls} custom={0} d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" initial={{ opacity: 1 }} variants={variants} />
          <circle cx="12" cy="12" r="2" />
          <motion.path animate={controls} custom={0} d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" initial={{ opacity: 1 }} variants={variants} />
          <motion.path animate={controls} custom={1} d="M19.1 4.9C23 8.8 23 15.1 19.1 19" initial={{ opacity: 1 }} variants={variants} />
        </svg>
      </div>
    );
  },
);
RadioIcon.displayName = "RadioIcon";

/** User-selected Cloud Upload implementation, with only a duration scale added for lab review. */
export const CloudUploadIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, durationScale = 1, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);
    const startAnimation = useCallback(() => { void controls.start("initial"); }, [controls]);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return { startAnimation, stopAnimation: () => { void controls.start("active"); } };
    }, [controls, startAnimation]);

    return (
      <div
        className={className}
        onMouseEnter={(event) => {
          if (!isControlledRef.current) startAnimation();
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          if (!isControlledRef.current) void controls.start("active");
          onMouseLeave?.(event);
        }}
        {...props}
      >
        <svg fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width={size} aria-hidden="true">
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
      </div>
    );
  },
);
CloudUploadIcon.displayName = "CloudUploadIcon";

export function ProvidedAnimatedIcon({ kind, size = 20, playing, playId, reducedMotion, speed = "normal" }: { kind: ProvidedIconKind; size?: number; playing?: boolean; playId?: number; reducedMotion?: boolean; speed?: "normal" | "slow" }) {
  const ref = useRef<AnimatedIconHandle>(null);
  const durationScale = speed === "slow" ? 1.9 : 1;

  useEffect(() => {
    if (!playing || reducedMotion) return;
    ref.current?.startAnimation();
    if (kind !== "cloud-upload-outline") return;
    const timer = window.setTimeout(() => ref.current?.stopAnimation(), 320 * durationScale);
    return () => window.clearTimeout(timer);
  }, [durationScale, kind, playId, playing, reducedMotion]);

  const Icon = kind === "radio" ? RadioIcon : CloudUploadIcon;
  return (
    <motion.span
      className="provided-animated-icon"
      animate={playing && reducedMotion ? { opacity: [1, .35, 1] } : { opacity: 1 }}
      transition={{ duration: .7 * durationScale }}
    >
      <Icon ref={ref} size={size} durationScale={durationScale} />
    </motion.span>
  );
}
