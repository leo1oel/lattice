import {
  forwardRef,
  useState,
  type ReactNode,
} from "react";
import { Trash2 } from "lucide-react";
import {
  motion,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import { PRESS_SPRING } from "../../motion";

export type DestructiveButtonProps = Omit<HTMLMotionProps<"button">, "children"> & {
  children?: ReactNode;
  iconSize?: number;
  iconClassName?: string;
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
      iconClassName,
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
          transition={animate ? { duration: 0.4 } : { duration: 0.12 }}
        >
          <Trash2 size={iconSize} className={iconClassName} />
        </motion.span>
        {children}
      </motion.button>
    );
  },
);
