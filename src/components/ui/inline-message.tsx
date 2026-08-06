import { AlertTriangle, CheckCircle2, CircleAlert, Info } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

/**
 * The one shape for a message that stays where it is.
 *
 * Its counterpart is the toast stack (`app-notify.ts`). The split:
 *
 *   event  → an action the user started has finished → toast
 *   state  → why this region has no content, or whether this field is valid
 *            → this component, in place
 *
 * Before this existed, every panel invented its own: `.overleaf-error`,
 * `.versions-notice`, `.conflict-error`, `.tex-setup-status`, each a bare
 * coloured `<p>` at a different size with no icon. Same icons and same status
 * colours as the toast, so the two read as one system.
 *
 * `Field`'s `error`/`hint` slots stay as they are — a caption under a single
 * control is a label, not a message, and does not want an icon beside it.
 */
const INLINE_MESSAGE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: CircleAlert,
};

export type InlineMessageLevel = keyof typeof INLINE_MESSAGE_ICON;

export function InlineMessage({
  level = "info",
  className,
  children,
}: {
  level?: InlineMessageLevel;
  className?: string;
  children: ReactNode;
}) {
  const Icon = INLINE_MESSAGE_ICON[level];
  return (
    <p
      className={cn("ui-inline-message", level, className)}
      // Failures interrupt; everything else is polite. Matches `AppToast`.
      role={level === "error" ? "alert" : "status"}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
