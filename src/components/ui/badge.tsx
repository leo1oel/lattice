import {
  type ComponentPropsWithoutRef,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { cn } from "@/lib/utils";
import { uiTokens } from "./stylex-tokens.stylex";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
type BadgeSize = "compact" | "default";

const styles = stylex.create({
  root: {
    alignItems: "center",
    backgroundColor: uiTokens.borderSubtle,
    borderRadius: uiTokens.radiusIcon,
    color: uiTokens.textSecondary,
    display: "inline-flex",
    fontSize: uiTokens.typeMicroSize,
    fontStyle: "normal",
    fontWeight: uiTokens.typeMicroWeight,
    gap: uiTokens.space2,
    height: uiTokens.badgeHeight,
    justifyContent: "center",
    lineHeight: uiTokens.typeMicroLineHeight,
    minWidth: 0,
    paddingBlock: 0,
    paddingInline: uiTokens.space3,
    whiteSpace: "nowrap",
  },
  compact: {
    height: uiTokens.badgeHeightCompact,
    paddingInline: uiTokens.space2,
  },
  default: {},
  neutral: {},
  accent: {
    backgroundColor: uiTokens.controlActiveSoft,
    color: uiTokens.controlActive,
  },
  success: {
    backgroundColor: uiTokens.statusSuccessSoft,
    color: uiTokens.statusSuccess,
  },
  warning: {
    backgroundColor: uiTokens.statusWarningSoft,
    color: uiTokens.statusWarning,
  },
  danger: {
    backgroundColor: uiTokens.statusDangerSoft,
    color: uiTokens.statusDanger,
  },
});

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
  const styleProps = stylex.props(styles.root, styles[size], styles[tone]);

  return (
    <span
      {...props}
      {...styleProps}
      data-slot="badge"
      data-size={size}
      data-tone={tone}
      className={cn("ui-badge", styleProps.className, className)}
    />
  );
}
