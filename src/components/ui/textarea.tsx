import {
  forwardRef,
  type ComponentPropsWithoutRef,
} from "react";
import { cn } from "@/lib/utils";
import "./form-controls.css";

export type TextareaProps = ComponentPropsWithoutRef<"textarea"> & {
  font?: "ui" | "mono";
  invalid?: boolean;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    font = "ui",
    invalid,
    ...props
  },
  ref,
) {
  return (
    <textarea
      {...props}
      ref={ref}
      data-slot="textarea"
      data-font={font}
      aria-invalid={invalid || undefined}
      className={cn("ui-textarea", className)}
    />
  );
});
