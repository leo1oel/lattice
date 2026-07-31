import {
  forwardRef,
  type ComponentPropsWithoutRef,
} from "react";
import { cn } from "@/lib/utils";
import "./form-controls.css";

export type InputProps = ComponentPropsWithoutRef<"input"> & {
  controlSize?: "compact" | "default" | "form";
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    controlSize = "default",
    invalid,
    ...props
  },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      data-slot="input"
      data-control-size={controlSize}
      aria-invalid={invalid || undefined}
      className={cn("ui-input", className)}
    />
  );
});
