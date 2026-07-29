import {
  forwardRef,
  useCallback,
  type ForwardedRef,
  type InputHTMLAttributes,
} from "react";
import "./chrome.css";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  indeterminate?: boolean;
};

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  if (ref) ref.current = value;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    className,
    indeterminate = false,
    disabled,
    ...props
  },
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
      disabled={disabled}
      aria-checked={indeterminate ? "mixed" : props["aria-checked"]}
      data-slot="checkbox"
      data-state={indeterminate ? "indeterminate" : props.checked ? "checked" : "unchecked"}
      className={`ui-checkbox${className ? ` ${className}` : ""}`}
    />
  );
});
