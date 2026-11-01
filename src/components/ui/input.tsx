import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import { useCompositionSafeKeys } from "@/hooks/use-composition-guard";
import "./form-controls.css";

export type InputProps = ComponentPropsWithoutRef<"input"> & {
  controlSize?: "compact" | "default";
};

/** `onKeyDown` never sees a key an input method is composing with (`useCompositionSafeKeys`). */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, controlSize = "default", onKeyDown, onCompositionStart, onCompositionEnd, ...props },
  ref,
) {
  const keys = useCompositionSafeKeys({ onKeyDown, onCompositionStart, onCompositionEnd });
  return (
    <input
      {...props}
      {...keys}
      ref={ref}
      data-slot="input"
      data-control-size={controlSize}
      className={cn("ui-input", className)}
    />
  );
});
