import {
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import "./chrome.css";

export type SettingsSectionHeaderProps = Omit<
  ComponentPropsWithoutRef<"div">,
  "title"
> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingId?: string;
};

/**
 * Page-level heading pattern for Settings sections.
 *
 * It owns heading/description rhythm and action alignment; the surrounding
 * settings section still owns page padding and feature content.
 */
export function SettingsSectionHeader({
  actions,
  className,
  description,
  headingId,
  title,
  ...props
}: SettingsSectionHeaderProps) {
  return (
    <div
      data-slot="settings-section-header"
      className={cn("ui-settings-section-header", className)}
      {...props}
    >
      <div className="ui-settings-section-header-copy">
        <h2 id={headingId} className="ui-settings-section-header-title">
          {title}
        </h2>
        {description && (
          <p className="ui-settings-section-header-description">{description}</p>
        )}
      </div>
      {actions && (
        <div className="ui-settings-section-header-actions">{actions}</div>
      )}
    </div>
  );
}
