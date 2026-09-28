import { forwardRef, useCallback, type InputHTMLAttributes } from "react";
import { assignRef } from "@/lib/utils";
import "./chrome.css";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  indeterminate?: boolean;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, indeterminate = false, ...props },
  forwardedRef,
) {
  const setRef = useCallback((node: HTMLInputElement | null) => {
    if (node) node.indeterminate = indeterminate;
    assignRef(forwardedRef, node);
  }, [forwardedRef, indeterminate]);

  return (
    <input
      {...props}
      ref={setRef}
      type="checkbox"
      aria-checked={indeterminate ? "mixed" : props["aria-checked"]}
      data-slot="checkbox"
      data-state={indeterminate ? "indeterminate" : props.checked ? "checked" : "unchecked"}
      className={`ui-checkbox${className ? ` ${className}` : ""}`}
    />
  );
});
