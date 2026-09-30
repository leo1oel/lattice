import { CheckCircle2, CircleAlert, Info } from "lucide-react";
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
 * Same icons and same status colours as the toast, so the two read as one
 * system. A form control's own caption stays as it is — a caption under a
 * single control is a label, not a message, and does not want an icon beside it.
 */
const LEVEL_ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: CircleAlert,
  error: CircleAlert,
};

export type InlineMessageLevel = keyof typeof LEVEL_ICONS;

export function InlineMessage({ level = "info", className, children }: {
  level?: InlineMessageLevel;
  className?: string;
  children: ReactNode;
}) {
  const Icon = LEVEL_ICONS[level];

  return (
    <p
      className={cn("ui-inline-message", level, className)}
      // Failures interrupt; everything else is polite. Matches `AppToast`.
      role={level === "error" ? "alert" : "status"}
    >
      <Icon className="ui-inline-message-icon" size={13} aria-hidden="true" />
      <span className="ui-inline-message-copy">{children}</span>
    </p>
  );
}
