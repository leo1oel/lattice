import { motion, useReducedMotion } from "motion/react";
import { spring } from "@/components/ui/motion-values";
import "./chrome.css";

export type SwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  id?: string;
  disabled?: boolean;
};

/**
 * Fluid Functionalism switch motion, adapted to the existing compact geometry
 * and controlled API. Keep click/keyboard activation native rather than adding
 * drag-to-toggle or a second clickable label around settings rows.
 * Source: https://www.fluidfunctionalism.com/r/base/switch.json
 * Fluid Functionalism (https://github.com/mickadesign/fluid-functionalism): MIT License, Copyright (c) 2026 Micka Touillaud.
 * Full license text: THIRD_PARTY_NOTICES.md.
 */
export function Switch({ checked, disabled, id, label, onChange }: SwitchProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-slot="switch"
      className="ui-switch"
      onClick={() => onChange(!checked)}
      initial={false}
      animate="rest"
      whileHover={disabled || reduceMotion ? "rest" : "hover"}
      whileTap={disabled || reduceMotion ? "rest" : "press"}
    >
      <motion.span
        aria-hidden="true"
        data-slot="switch-thumb"
        className="ui-switch-thumb"
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
