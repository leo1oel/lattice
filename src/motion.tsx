// Shared motion primitives (Framer Motion / `motion`). Micro-interactions in the
// spirit of Amicro, tuned to stay light: only transform/opacity animate (GPU
// composited) and springs are short, so they hold up on weak WebKit (the macOS
// VM). Reach for these instead of hand-rolling motion props per call site.
import { forwardRef, useId, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  type HTMLMotionProps,
} from "motion/react";
import {
  MAGNET_SPRING,
  POP_SPRING,
  PRESS_SPRING,
  SETTLE_SPRING,
} from "./motion-values";
import "./motion.css";

type MotionButtonProps = HTMLMotionProps<"button"> & {
  /** Gently pull the button toward the cursor while hovering (Amicro-style). */
  magnetic?: boolean;
  /** How far it pulls, as a fraction of the cursor offset from center. */
  magnetStrength?: number;
};

/**
 * Drop-in replacement for `<button>` that adds a subtle hover lift and an
 * optional magnetic pull. Keeps the same className so
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

/**
 * Swaps one icon for another while the pointer is over the enclosing control,
 * springing between them rather than cutting.
 *
 * Worth it on a single prominent button, where the change reads as an
 * invitation — a folder that opens as you reach for it. Not worth it per row
 * in a list: the mount/unmount cost is paid on every hover, and a dozen icons
 * springing as the cursor crosses them is noise, not feedback.
 */
export function MorphIcon(props: { idle: ReactNode; hover: ReactNode; size?: number }) {
  const [over, setOver] = useState(false);
  const size = props.size ?? 16;
  return (
    <span
      className="morph-icon"
      style={{ width: size, height: size }}
      onMouseEnter={() => setOver(true)}
      onMouseLeave={() => setOver(false)}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={over ? "hover" : "idle"}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={POP_SPRING}
        >
          {over ? props.hover : props.idle}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export type SlidingTab = { value: string; label: ReactNode; title?: string };

/**
 * A tab strip where the selected background slides from the old tab to the new
 * one instead of blinking across.
 *
 * One element carries `layoutId`, so it is the *same* element before and after
 * the selection changes and the library animates it between the two positions.
 * That is what says "this moved here", which a class swap cannot: with the
 * highlight simply appearing elsewhere, the eye has to find it again, and in a
 * strip of five that is a real pause.
 *
 * `layoutId` is scoped per instance, or two strips on screen would animate
 * their pills into each other.
 */
export function SlidingTabs(props: {
  value: string;
  onChange: (value: string) => void;
  items: SlidingTab[];
  ariaLabel: string;
  /**
   * What slides. "pill" is a filled background, for strips that sit on a
   * panel; "underline" is a rule along the bottom, for strips that head a
   * section. Each place keeps the shape it already had — only the way the
   * indicator gets from one tab to the next changes.
   */
  variant?: "pill" | "underline";
  /** The strip's own class, so each place keeps its existing styling. */
  className?: string;
  /** Class for each tab, for the same reason. */
  tabClassName?: string;
}) {
  const pillId = useId();
  const reduceMotion = useReducedMotion();
  return (
    <div className={`sliding-tabs${props.className ? ` ${props.className}` : ""}`} role="tablist" aria-label={props.ariaLabel}>
      {props.items.map((item, index) => {
        const selected = item.value === props.value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            title={item.title}
            className={`sliding-tab${selected ? " active" : ""}${props.tabClassName ? ` ${props.tabClassName}` : ""}`}
            onClick={() => props.onChange(item.value)}
            onKeyDown={(event) => {
              let nextIndex: number | null = null;
              if (event.key === "ArrowRight") nextIndex = (index + 1) % props.items.length;
              if (event.key === "ArrowLeft") nextIndex = (index - 1 + props.items.length) % props.items.length;
              if (event.key === "Home") nextIndex = 0;
              if (event.key === "End") nextIndex = props.items.length - 1;
              if (nextIndex == null) return;

              event.preventDefault();
              props.onChange(props.items[nextIndex].value);
              const tabs = event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              tabs?.[nextIndex]?.focus();
            }}
          >
            {selected && (
              <motion.span
                aria-hidden
                className={props.variant === "underline" ? "sliding-tab-underline" : "sliding-tab-pill"}
                layoutId={reduceMotion ? undefined : `${pillId}-pill`}
                transition={reduceMotion ? { duration: 0 } : SETTLE_SPRING}
              />
            )}
            <span className="sliding-tab-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
