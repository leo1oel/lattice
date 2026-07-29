import {
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/icon-tip";
import "./chrome.css";

type IconButtonSize = "compact" | "default" | "large";
type IconButtonTone = "neutral" | "primary" | "danger";

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title"
> & {
  label: string;
  tooltip?: ReactNode | false;
  size?: IconButtonSize;
  tone?: IconButtonTone;
};

/**
 * The single app-level primitive for icon-only actions.
 *
 * It owns the hit target, radius, hover/focus behavior, accessible name, and
 * tooltip so feature code only supplies the action and icon.
 */
export function IconButton({
  children,
  className,
  label,
  tooltip = label,
  size = "default",
  tone = "neutral",
  type = "button",
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      data-slot="icon-button"
      data-size={size}
      data-tone={tone}
      className={cn("ui-icon-button", className)}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );

  return tooltip ? <Tip label={tooltip}>{button}</Tip> : button;
}

export function CloseButton({
  label = "Close panel",
  ...props
}: Omit<IconButtonProps, "children"> & { label?: string }) {
  return (
    <IconButton label={label} {...props}>
      <X aria-hidden="true" />
    </IconButton>
  );
}
