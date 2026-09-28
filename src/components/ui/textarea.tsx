import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import "./form-controls.css";

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea {...props} ref={ref} data-slot="textarea" className={cn("ui-textarea", className)} />;
});
