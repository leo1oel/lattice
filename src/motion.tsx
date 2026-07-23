// Shared motion primitives (Framer Motion / `motion`). Micro-interactions in the
// spirit of Amicro, tuned to stay light: only transform/opacity animate (GPU
// composited) and springs are short, so they hold up on weak WebKit (the macOS
// VM). Reach for these instead of hand-rolling motion props per call site.
import { forwardRef, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  type HTMLMotionProps,
  type Transition,
} from "motion/react";

/** Snappy press/hover feel for buttons — quick settle, no overshoot wobble. */
export const PRESS_SPRING: Transition = { type: "spring", stiffness: 520, damping: 32, mass: 0.6 };
/** Softer spring for the magnetic pull, so it trails the cursor smoothly. */
const MAGNET_SPRING: Transition = { type: "spring", stiffness: 260, damping: 22, mass: 0.5 };
/** Entrance spring for popovers/menus/cards — a small, confident pop. */
export const POP_SPRING: Transition = { type: "spring", stiffness: 460, damping: 34, mass: 0.7 };

type MotionButtonProps = HTMLMotionProps<"button"> & {
  /** Gently pull the button toward the cursor while hovering (Amicro-style). */
  magnetic?: boolean;
  /** How far it pulls, as a fraction of the cursor offset from center. */
  magnetStrength?: number;
};

/**
 * Drop-in replacement for `<button>` that adds a spring press (`whileTap`) and a
 * subtle hover lift, plus an optional magnetic pull. Keeps the same className so
 * existing styles apply unchanged; disabled buttons get no motion.
 */
export const MotionButton = forwardRef<HTMLButtonElement, MotionButtonProps>(
  function MotionButton(
    { magnetic = false, magnetStrength = 0.3, disabled, style, onMouseMove, onMouseLeave, children, ...rest },
    forwardedRef,
  ) {
    const localRef = useRef<HTMLButtonElement | null>(null);
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const springX = useSpring(x, MAGNET_SPRING);
    const springY = useSpring(y, MAGNET_SPRING);
    const active = magnetic && !disabled;

    return (
      <motion.button
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === "function") forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        disabled={disabled}
        style={active ? { ...style, x: springX, y: springY } : style}
        whileHover={disabled ? undefined : { scale: 1.03 }}
        whileTap={disabled ? undefined : { scale: 0.96 }}
        transition={PRESS_SPRING}
        onMouseMove={(event) => {
          if (active && localRef.current) {
            const rect = localRef.current.getBoundingClientRect();
            x.set((event.clientX - rect.left - rect.width / 2) * magnetStrength);
            y.set((event.clientY - rect.top - rect.height / 2) * magnetStrength);
          }
          onMouseMove?.(event);
        }}
        onMouseLeave={(event) => {
          if (active) {
            x.set(0);
            y.set(0);
          }
          onMouseLeave?.(event);
        }}
        {...rest}
      >
        {children}
      </motion.button>
    );
  },
);

/**
 * Crossfade + spin-scale morph between two icon states, keyed by `swapKey`.
 * Used for copy→check and the light/dark sun↔moon toggle — the swap reads as a
 * deliberate transformation instead of an instant flip.
 */
export function IconSwap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", position: "relative" }}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={swapKey}
          style={{ display: "inline-flex" }}
          initial={{ opacity: 0, scale: 0.5, rotate: -45 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={{ opacity: 0, scale: 0.5, rotate: 45 }}
          transition={{ type: "spring", stiffness: 620, damping: 26, mass: 0.5 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Icon button that spins its contents one full turn on each click (a satisfying
 * refresh gesture) and spins continuously while `busy`. Falls back to the same
 * className so existing button styles apply.
 */
export const SpinButton = forwardRef<HTMLButtonElement, HTMLMotionProps<"button"> & { busy?: boolean }>(
  function SpinButton({ busy = false, onClick, children, ...rest }, ref) {
    const [turns, setTurns] = useState(0);
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.88 }}
        transition={PRESS_SPRING}
        onClick={(event) => {
          setTurns((value) => value + 1);
          onClick?.(event);
        }}
        {...rest}
      >
        <motion.span
          style={{ display: "inline-flex" }}
          animate={busy ? { rotate: 360 } : { rotate: turns * 360 }}
          transition={
            busy
              ? { repeat: Infinity, duration: 0.8, ease: "linear" }
              : { type: "spring", stiffness: 240, damping: 22, mass: 0.7 }
          }
        >
          {children}
        </motion.span>
      </motion.button>
    );
  },
);

/** Spring pop-in wrapper for overlays (dialogs, menus, cards). */
export function PopIn({ children, ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, y: 4 }}
      transition={POP_SPRING}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
