import { forwardRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import { Tip } from "@/components/icon-tip";
import { cn } from "@/lib/utils";
import { PRESS_SPRING, springExit } from "./motion-values";

export type DestructiveButtonProps = Omit<HTMLMotionProps<"button">, "children"> & {
  children?: ReactNode;
  iconSize?: number;
};

/**
 * Shared destructive control. The restrained shake makes the destructive
 * affordance legible without turning every row into a looping animation.
 */
export const DestructiveButton = forwardRef<HTMLButtonElement, DestructiveButtonProps>(
  function DestructiveButton(
    {
      children,
      disabled,
      iconSize = 14,
      onHoverStart,
      onHoverEnd,
      ...props
    },
    ref,
  ) {
    const [hovered, setHovered] = useState(false);
    const reduceMotion = useReducedMotion();
    const animate = hovered && !disabled && !reduceMotion;

    return (
      <motion.button
        ref={ref}
        type="button"
        disabled={disabled}
        whileHover={disabled || reduceMotion ? undefined : { scale: 1.02 }}
        whileTap={disabled || reduceMotion ? undefined : { scale: 0.96 }}
        transition={PRESS_SPRING}
        onHoverStart={(event, info) => {
          setHovered(true);
          onHoverStart?.(event, info);
        }}
        onHoverEnd={(event, info) => {
          setHovered(false);
          onHoverEnd?.(event, info);
        }}
        {...props}
      >
        <motion.span
          className="destructive-button-icon"
          aria-hidden="true"
          animate={animate
            ? {
                y: [0, -2, 0, -2, 0],
                rotate: [0, -10, 10, -10, 0],
              }
            : { y: 0, rotate: 0 }}
          transition={animate ? { duration: 0.4 } : springExit.moderate}
        >
          <Trash2 size={iconSize} />
        </motion.span>
        {children}
      </motion.button>
    );
  },
);

/**
 * The destructive control as an icon-only action among IconButtons: their
 * plate, size, tooltip and accessible name, turning to the danger colour on
 * hover. Without the shared class a bare one draws the browser's own button.
 */
export function DestructiveIconButton({ label, size = "default", className, iconSize, ...props }: Omit<DestructiveButtonProps, "aria-label" | "title"> & {
  label: string;
  size?: "compact" | "default";
}) {
  return (
    <Tip label={label}>
      <DestructiveButton data-size={size} data-tone="danger" className={cn("ui-icon-button", className)} aria-label={label} iconSize={iconSize ?? (size === "compact" ? 13 : 16)} {...props} />
    </Tip>
  );
}
