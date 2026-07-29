import {
  type ButtonHTMLAttributes,
} from "react";
import {
  buttonClassName,
  type ButtonSize,
  type ButtonVariant,
} from "./button-styles";
import "./chrome.css";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * App-level text button. Icon-only actions use IconButton instead.
 */
export function Button({
  className,
  size = "default",
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      data-size={size}
      data-variant={variant}
      className={buttonClassName({ variant, size, className })}
      {...props}
    />
  );
}
