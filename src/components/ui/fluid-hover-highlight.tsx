// Adapted from https://www.fluidfunctionalism.com/r/use-fluid-hover.json.
// Lattice uses its existing Motion runtime and semantic surface tokens.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { spring, springExit } from "./motion-values";
import type { UseFluidHoverReturn } from "./use-fluid-hover";

type FluidHoverSource = Pick<UseFluidHoverReturn, "activeIndex" | "itemRects" | "isMeasured" | "sessionRef">;

/** The measured rect to sit on, as animation targets (position as a
 *  transform, size as layout), and the pointer session that keys it. */
function resolveTarget({ activeIndex, itemRects, isMeasured, sessionRef }: FluidHoverSource) {
  const rect = isMeasured && activeIndex !== null ? itemRects[activeIndex] : undefined;
  const target = rect && { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  return { target, session: sessionRef.current };
}

/**
 * The one hover highlight every fluid hover list renders: an absolutely
 * positioned fill that springs between the rects `useFluidHover` measures.
 * A new pointer session re-keys it, so it fades in on the row instead of
 * sliding over from wherever it was last. It owns no layout opinion beyond
 * `absolute`: radius, z-index, and the offsetParent (the container must be
 * `relative`) are the consumer's.
 */
export function FluidHoverHighlight({ hover, className }: { hover: FluidHoverSource; className?: string }) {
  const { target, session } = resolveTarget(hover);
  // Reads the OS media query directly, so reduced motion is honoured without
  // the app wrapping its tree in MotionConfig. It keeps the opacity fade and
  // drops the travel, per the motion guidelines: fewer and gentler, not none.
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <AnimatePresence>
      {target && (
        <motion.div
          key={session}
          data-slot="fluid-hover-highlight"
          aria-hidden="true"
          // Pinned to the container's padding corner and moved with a
          // transform, so the travel runs on the compositor instead of
          // re-laying out every frame. Width and height are real layout
          // values, but they only change when the target rect's size does,
          // which in most lists is never.
          className={cn("pointer-events-none absolute left-0 top-0", className)}
          initial={{ opacity: 0, ...target }}
          animate={{ opacity: 1, ...target }}
          exit={{ opacity: 0, transition: springExit.fast }}
          transition={{ ...(reduceMotion ? { duration: 0 } : spring.fast), opacity: { duration: spring.fast.duration } }}
        />
      )}
    </AnimatePresence>
  );
}
