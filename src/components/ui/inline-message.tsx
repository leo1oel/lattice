import { CheckCircle2, CircleAlert, Info } from "lucide-react";
import { type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { cn } from "@/lib/utils";
import { uiTokens } from "./stylex-tokens.stylex";

const styles = stylex.create({
  root: {
    alignItems: "flex-start",
    color: uiTokens.textSecondary,
    display: "flex",
    fontSize: uiTokens.typeCaptionSize,
    fontWeight: uiTokens.typeCaptionWeight,
    gap: uiTokens.space3,
    lineHeight: uiTokens.typeCaptionLineHeight,
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  errorText: {
    color: uiTokens.textPrimary,
  },
  icon: {
    flexBasis: "auto",
    flexGrow: 0,
    flexShrink: 0,
    marginTop: "calc((var(--type-caption-line-height) - 13px) / 2)",
  },
  infoIcon: {
    color: uiTokens.statusInfo,
  },
  successIcon: {
    color: uiTokens.statusSuccess,
  },
  warningIcon: {
    color: uiTokens.statusWarning,
  },
  errorIcon: {
    color: uiTokens.statusDanger,
  },
  copy: {
    minWidth: 0,
  },
});

/**
 * The one shape for a message that stays where it is.
 *
 * Its counterpart is the toast stack (`app-notify.ts`). The split:
 *
 *   event  → an action the user started has finished → toast
 *   state  → why this region has no content, or whether this field is valid
 *            → this component, in place
 *
 * Same icons and same status colours as the toast, so the two read as one
 * system. A form control's own caption stays as it is — a caption under a
 * single control is a label, not a message, and does not want an icon beside it.
 */
const LEVELS = {
  info: { Icon: Info, iconStyle: styles.infoIcon },
  success: { Icon: CheckCircle2, iconStyle: styles.successIcon },
  warning: { Icon: CircleAlert, iconStyle: styles.warningIcon },
  error: { Icon: CircleAlert, iconStyle: styles.errorIcon },
};

export type InlineMessageLevel = keyof typeof LEVELS;

export function InlineMessage({ level = "info", className, children }: {
  level?: InlineMessageLevel;
  className?: string;
  children: ReactNode;
}) {
  const { Icon, iconStyle } = LEVELS[level];
  const rootStyleProps = stylex.props(
    styles.root,
    level === "error" && styles.errorText,
  );

  return (
    <p
      {...rootStyleProps}
      className={cn("ui-inline-message", level, rootStyleProps.className, className)}
      // Failures interrupt; everything else is polite. Matches `AppToast`.
      role={level === "error" ? "alert" : "status"}
    >
      <Icon {...stylex.props(styles.icon, iconStyle)} size={13} aria-hidden="true" />
      <span {...stylex.props(styles.copy)}>{children}</span>
    </p>
  );
}
