import { useEffect, useRef } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import * as stylex from "@stylexjs/stylex";
import { PRESS_SPRING, SETTLE_SPRING } from "@/components/ui/motion-values";
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
    transformOrigin: "center",
    width: uiTokens.controlSizeSwitchThumb,
  },
});

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
};

/**
 * App-level binary setting control with a visible travelling thumb.
 */
export function Switch({
  checked,
  className,
  disabled,
  label,
  onChange,
}: SwitchProps) {
  const reduceMotion = useReducedMotion();
  const x = useMotionValue(checked ? 10 : 0);
  const scaleX = useMotionValue(1);
  const previous = useRef(checked);
  const rootStyleProps = stylex.props(
    styles.root,
    checked && styles.checked,
    disabled && styles.disabled,
  );
  const thumbStyleProps = stylex.props(styles.thumb);

  useEffect(() => {
    if (previous.current === checked) return;
    previous.current = checked;
    const target = checked ? 10 : 0;
    if (reduceMotion) x.set(target);
    else void animate(x, target, SETTLE_SPRING);
  }, [checked, reduceMotion, x]);

  const squash = (to: number) => {
    if (reduceMotion || disabled) return;
    void animate(scaleX, to, to > 1 ? PRESS_SPRING : SETTLE_SPRING);
  };

  return (
    <button
      {...rootStyleProps}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      className={cn("ui-switch", rootStyleProps.className, className)}
      onClick={() => onChange(!checked)}
      onPointerDown={() => squash(1.18)}
      onPointerUp={() => squash(1)}
      onPointerLeave={() => squash(1)}
      onPointerCancel={() => squash(1)}
    >
      <motion.span
        {...thumbStyleProps}
        className={cn("ui-switch-thumb", thumbStyleProps.className)}
        style={{ x, scaleX }}
      />
    </button>
  );
}
