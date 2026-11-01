import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { useCompositionSafeKeys } from "@/hooks/use-composition-guard";
import "./form-controls.css";

/** `onKeyDown` never sees a key an input method is composing with (`useCompositionSafeKeys`). */
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function Textarea(
  { className, onKeyDown, onCompositionStart, onCompositionEnd, ...props },
  ref,
) {
  const keys = useCompositionSafeKeys({ onKeyDown, onCompositionStart, onCompositionEnd });
  return <textarea {...props} {...keys} ref={ref} data-slot="textarea" className={cn("ui-textarea", className)} />;
});
