import { useLingui } from "@lingui/react/macro";
import { cn } from "@/lib/utils";

/** The open-or-all toggle above a comment list; the editor and Overleaf panels share it. */
export function CommentVisibilityFilter({ showResolved, onChange, openLabel, resolvedLabel, className }: {
  showResolved: boolean;
  onChange: (showResolved: boolean) => void;
  openLabel: string;
  resolvedLabel: string;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <div className={cn("pdf-marks-kind-filter", className)} role="group" aria-label={t`Comment visibility`}>
      {([[false, openLabel], [true, resolvedLabel]] as const).map(([value, label]) => (
        <button
          key={String(value)}
          type="button"
          className={`ui-compact-selectable${showResolved === value ? " active" : ""}`}
          aria-pressed={showResolved === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
