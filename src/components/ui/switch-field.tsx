import {
  type ComponentPropsWithoutRef,
} from "react";
import { cn } from "@/lib/utils";
import { rowClassName } from "./row";
import { Switch } from "./switch";
import "./chrome.css";

export type SwitchFieldProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "children" | "onChange"
> & {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

/**
 * A persistent binary setting: aligned copy plus the shared Switch primitive.
 */
export function SwitchField({
  checked,
  className,
  description,
  disabled,
  label,
  onChange,
  ...props
}: SwitchFieldProps) {
  return (
    <div
      data-slot="switch-field"
      className={rowClassName("data", cn("ui-switch-field", className))}
      {...props}
    >
      <div className="ui-switch-field-copy">
        <span className="ui-switch-field-label">{label}</span>
        {description && <p className="ui-switch-field-description">{description}</p>}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        label={label}
        onChange={onChange}
      />
    </div>
  );
}
