import {
  type ComponentPropsWithoutRef,
} from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type BadgeSize = "compact" | "default";

export type BadgeProps = ComponentPropsWithoutRef<"span"> & {
  tone?: BadgeTone;
  size?: BadgeSize;
};

/**
 * Compact semantic status or metadata label.
 *
 * Counts that are positioned over an icon remain feature-owned because their
 * geometry is notification chrome rather than an inline badge.
 */
export function Badge({
  className,
  size = "default",
  tone = "neutral",
  ...props
}: BadgeProps) {
  return (
    <span
      data-slot="badge"
      data-size={size}
      data-tone={tone}
      className={cn("ui-badge", className)}
      {...props}
    />
  );
}
