import {
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { CloseButton } from "./icon-button";
import "./chrome.css";

export type PanelHeaderProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "title"
> & {
  title: ReactNode;
  icon?: ReactNode;
  titleAfter?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  closeTooltip?: ReactNode | false;
  closeDisabled?: boolean;
};

/**
 * Shared title/action layout for drawers, panels, and modal headers.
 *
 * Feature classes may still own the outer height, padding, and border, while
 * the title typography, alignment, action spacing, and close behavior stay
 * consistent.
 */
export function PanelHeader({
  actions,
  className,
  closeDisabled,
  closeLabel,
  closeTooltip,
  icon,
  onClose,
  title,
  titleAfter,
  ...props
}: PanelHeaderProps) {
  const resolvedCloseLabel = closeLabel
    ?? (typeof title === "string" ? `Close ${title}` : "Close panel");

  return (
    <div
      data-slot="panel-header"
      className={cn("ui-panel-header", className)}
      {...props}
    >
      <div data-slot="panel-header-title" className="ui-panel-header-title">
        {icon}
        <span className="ui-panel-header-title-text">{title}</span>
        {titleAfter}
      </div>
      {(actions || onClose) && (
        <div data-slot="panel-header-actions" className="ui-panel-header-actions">
          {actions}
          {onClose && (
            <CloseButton
              label={resolvedCloseLabel}
              tooltip={closeTooltip ?? false}
              disabled={closeDisabled}
              onClick={onClose}
            />
          )}
        </div>
      )}
    </div>
  );
}
