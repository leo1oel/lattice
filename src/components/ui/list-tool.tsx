import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import "./list-tool.css";

export type ListToolProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children" | "value"> & {
  /** 14px icon that names the tool when it folds to an icon. */
  icon: ReactNode;
  /** What the tool does ("Filter", "Sort"), read before its value. */
  label: string;
  /** What it is set to now ("Unused", "Title"); omitted while it narrows nothing. */
  value?: ReactNode;
  /** Set away from the list's default: the value reads in full ink, and a folded tool shows a dot. */
  on?: boolean;
  /** The whole name, which a folded tool still announces. */
  name: string;
};

/**
 * A list's filter or sort, opening its menu (use it as a menu trigger with
 * `asChild`). It reads as "Sort  Title": what the tool does, then what it is
 * set to. A toolbar short of room folds it to its icon by hiding
 * `.list-tool-text` and `.list-tool-caret` in its own container query (see
 * list-tool.css); the dot then carries `on`.
 */
export const ListTool = forwardRef<HTMLButtonElement, ListToolProps>(function ListTool(
  { icon, label, value, on, name, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("list-tool", className)}
      data-on={on || undefined}
      aria-label={name}
      {...props}
    >
      {icon}
      <span className="list-tool-text" aria-hidden="true">
        <span className="list-tool-label">{label}</span>
        {value !== undefined && <span className="list-tool-value">{value}</span>}
      </span>
      <ChevronDown className="list-tool-caret" size={12} aria-hidden="true" />
    </button>
  );
});
