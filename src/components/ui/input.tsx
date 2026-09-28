import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import "./form-controls.css";

export type InputProps = ComponentPropsWithoutRef<"input"> & {
  controlSize?: "compact" | "default" | "form";
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, controlSize = "default", ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      data-slot="input"
      data-control-size={controlSize}
      className={cn("ui-input", className)}
    />
  );
});
