import type { ReactNode } from "react";
import { Checkbox, type CheckboxProps } from "./checkbox";
import "./chrome.css";

export type CheckboxFieldProps = Omit<CheckboxProps, "className"> & {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
  checkboxClassName?: string;
};

export function CheckboxField({
  label,
  description,
  className,
  checkboxClassName,
  ...checkboxProps
}: CheckboxFieldProps) {
  return (
    <label
      data-slot="checkbox-field"
      className={`ui-checkbox-field${className ? ` ${className}` : ""}`}
    >
      <Checkbox {...checkboxProps} className={checkboxClassName} />
      <span className="ui-checkbox-field-copy">
        <span className="ui-checkbox-field-label">{label}</span>
        {description ? <span className="ui-checkbox-field-description">{description}</span> : null}
      </span>
    </label>
  );
}
