import {
  motion,
  useReducedMotion,
} from "motion/react";
import * as stylex from "@stylexjs/stylex";
import { spring } from "@/components/ui/motion-values";
import { cn } from "@/lib/utils";
import { uiTokens } from "./stylex-tokens.stylex";

const styles = stylex.create({
  root: {
    backgroundColor: uiTokens.controlOffSurface,
    borderRadius: uiTokens.radiusPill,
    borderStyle: "none",
    cursor: "pointer",
    flexBasis: "auto",
    flexGrow: 0,
    flexShrink: 0,
    height: uiTokens.controlHeightSwitch,
    margin: 0,
    outline: "none",
    padding: uiTokens.space1,
    transitionDuration: uiTokens.switchTransitionDuration,
    transitionProperty: "background-color, opacity",
    transitionTimingFunction: uiTokens.switchTransitionTiming,
    width: uiTokens.controlWidthSwitch,
  },
  checked: {
    backgroundColor: uiTokens.controlOnSurface,
  },
  disabled: {
    cursor: "not-allowed",
    opacity: uiTokens.controlDisabledOpacity,
  },
  thumb: {
    backgroundColor: uiTokens.controlThumbSurface,
    borderRadius: uiTokens.radiusPill,
    display: "block",
    height: uiTokens.controlSizeSwitchThumb,
    width: uiTokens.controlSizeSwitchThumb,
  },
});

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
};

/**
 * Fluid Functionalism switch motion, adapted to the existing compact geometry
 * and controlled API. Keep click/keyboard activation native rather than adding
 * drag-to-toggle or a second clickable label around settings rows.
 * Source: https://www.fluidfunctionalism.com/r/base/switch.json
 */
export function Switch({
  checked,
  className,
  disabled,
  label,
  id,
  onChange,
}: SwitchProps) {
  const reduceMotion = useReducedMotion();
  const rootStyleProps = stylex.props(
    styles.root,
    checked && styles.checked,
    disabled && styles.disabled,
  );
  const thumbStyleProps = stylex.props(styles.thumb);

  return (
    <motion.button
      {...rootStyleProps}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      className={cn("ui-switch", rootStyleProps.className, className)}
      onClick={() => onChange(!checked)}
      initial={false}
      animate="rest"
      whileHover={disabled || reduceMotion ? "rest" : "hover"}
      whileTap={disabled || reduceMotion ? "rest" : "press"}
    >
      <motion.span
        {...thumbStyleProps}
        aria-hidden="true"
        data-slot="switch-thumb"
        className={cn("ui-switch-thumb", thumbStyleProps.className)}
        style={{ transformOrigin: checked ? "right center" : "left center" }}
        variants={{
          rest: { x: checked ? 12 : 0, scaleX: 1, scaleY: 1 },
          hover: { x: checked ? 12 : 0, scaleX: 1.2, scaleY: 1 },
          press: { x: checked ? 12 : 0, scaleX: 1.4, scaleY: 0.8 },
        }}
        transition={reduceMotion ? { duration: 0 } : spring.moderate}
      />
    </motion.button>
  );
}
