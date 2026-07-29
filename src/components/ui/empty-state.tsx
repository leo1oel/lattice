import {
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

export type EmptyStateProps = Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  density?: "compact" | "default";
  align?: "start" | "center";
  variant?: "plain" | "outlined";
};

/** A reusable no-content state without feature-specific class dependencies. */
export function EmptyState({
  actions,
  align = "center",
  className,
  density = "default",
  description,
  icon,
  title,
  variant = "plain",
  ...props
}: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      data-align={align}
      data-density={density}
      data-variant={variant}
      className={cn("ui-empty-state", className)}
      {...props}
    >
      {icon && <div className="ui-empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <strong className="ui-empty-state-title">{title}</strong>}
      {description && <p className="ui-empty-state-description">{description}</p>}
      {actions && <div className="ui-empty-state-actions">{actions}</div>}
    </div>
  );
}
