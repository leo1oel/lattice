import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

export type BadgeProps = ComponentPropsWithoutRef<"span"> & {
  tone?: "neutral" | "success" | "warning";
  size?: "compact" | "default";
};

/**
 * Compact semantic status or metadata label.
 *
 * Counts that are positioned over an icon remain feature-owned because their
 * geometry is notification chrome rather than an inline badge.
 */
export function Badge({ className, size = "default", tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      {...props}
      data-slot="badge"
      data-size={size}
      data-tone={tone}
      className={cn("ui-badge", className)}
    />
  );
}
