import { useEffect, useRef } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { PRESS_SPRING, SETTLE_SPRING } from "@/motion";
import { cn } from "@/lib/utils";
import "./chrome.css";

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
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      className={cn("ui-switch", className)}
      onClick={() => onChange(!checked)}
      onPointerDown={() => squash(1.18)}
      onPointerUp={() => squash(1)}
      onPointerLeave={() => squash(1)}
      onPointerCancel={() => squash(1)}
    >
      <motion.span className="ui-switch-thumb" style={{ x, scaleX }} />
    </button>
  );
}
