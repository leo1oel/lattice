import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "default" | "form";

export type ButtonClassOptions = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

/**
 * Shared classes for plain Button and an existing motion-enabled button.
 */
export function buttonClassName({
  variant = "secondary",
  size = "default",
  className,
}: ButtonClassOptions = {}) {
  return cn(
    "ui-button",
    `ui-button--${variant}`,
    `ui-button--${size}`,
    className,
  );
}
