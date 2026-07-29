import {
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

export type FieldProps = Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
};

/** Shared label/control/hint structure for form fields. */
export function Field({
  children,
  className,
  error,
  hint,
  htmlFor,
  label,
  ...props
}: FieldProps) {
  const labelNode = htmlFor ? (
    <label
      data-slot="field-label"
      className="ui-field-label"
      htmlFor={htmlFor}
    >
      {label}
    </label>
  ) : (
    <span data-slot="field-label" className="ui-field-label">{label}</span>
  );

  return (
    <div data-slot="field" className={cn("ui-field", className)} {...props}>
      {labelNode}
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
      {error && <span className="ui-field-error" role="alert">{error}</span>}
    </div>
  );
}
