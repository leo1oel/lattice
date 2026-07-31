import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import "./search-field.css";

export type SearchFieldProps = ComponentPropsWithoutRef<"input"> & {
  clearLabel?: string;
  containerClassName?: string;
  controlSize?: "compact" | "default";
  onClear?: () => void;
  showIcon?: boolean;
  trailing?: ReactNode;
};

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(
  function SearchField(
    {
      className,
      clearLabel = "Clear search",
      containerClassName,
      controlSize = "default",
      disabled,
      onClear,
      role = "searchbox",
      showIcon = true,
      trailing,
      type = "text",
      value,
      ...props
    },
    ref,
  ) {
    const hasValue = value !== undefined && value !== null && String(value).length > 0;

    return (
      <span
        className={cn("ui-search-field", containerClassName)}
        data-control-size={controlSize}
        data-disabled={disabled || undefined}
        data-slot="search-field"
      >
        {showIcon ? <Search className="ui-search-field-icon" aria-hidden="true" /> : null}
        <input
          {...props}
          ref={ref}
          role={role}
          type={type}
          disabled={disabled}
          value={value}
          className={cn("ui-search-field-input", className)}
          data-slot="search-field-input"
        />
        {onClear && hasValue && !disabled ? (
          <button
            type="button"
            className="ui-search-field-clear"
            aria-label={clearLabel}
            title={clearLabel}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClear}
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
        {trailing ? <span className="ui-search-field-trailing">{trailing}</span> : null}
      </span>
    );
  },
);
