import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { rowClassName } from "./row";
import "./chrome.css";

export type SettingsGroupProps = Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  /** Omitted for a page's leading group, which its page title already names. */
  title?: ReactNode;
  children: ReactNode;
};

/**
 * A titled band of settings rows.
 *
 * Rows sit in one bordered card under the heading, a hairline between each,
 * so a page reads as a few groups rather than a column of loose lines. A group
 * that holds no row (a log, a checklist) keeps its contents unframed.
 */
export function SettingsGroup({ children, className, title, ...props }: SettingsGroupProps) {
  return (
    <section
      data-slot="settings-group"
      className={cn("ui-settings-group", className)}
      {...props}
    >
      {title && <h3 className="ui-settings-group-title">{title}</h3>}
      <div className="ui-settings-group-body">{children}</div>
    </section>
  );
}

export type SettingsRowProps = Omit<ComponentPropsWithoutRef<"div">, "children" | "title"> & {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
};

/**
 * One setting: copy on the left, its control on the right.
 *
 * Shares the SwitchField metrics so a page can mix both without the rows
 * changing height or alignment.
 */
export function SettingsRow({
  children,
  className,
  description,
  htmlFor,
  label,
  ...props
}: SettingsRowProps) {
  const labelNode = htmlFor ? (
    <label className="ui-settings-row-label" htmlFor={htmlFor}>{label}</label>
  ) : (
    <span className="ui-settings-row-label">{label}</span>
  );

  return (
    <div
      data-slot="settings-row"
      className={rowClassName("data", cn("ui-settings-row", className))}
      {...props}
    >
      <div className="ui-settings-row-copy">
        {labelNode}
        {description && (
          <p className="ui-settings-row-description">{description}</p>
        )}
      </div>
      {children && <div className="ui-settings-row-control">{children}</div>}
    </div>
  );
}
