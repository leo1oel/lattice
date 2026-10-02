import { useLingui } from "@lingui/react/macro";
import { cn } from "@/lib/utils";

/**
 * The open-or-all toggle above a comment list; the editor and Overleaf panels
 * share it. Drawn as a segmented track, like the switchers beside it, but kept
 * as pressed buttons: it filters a list rather than switching views.
 */
export function CommentVisibilityFilter({ showResolved, onChange, openLabel, resolvedLabel, className }: {
  showResolved: boolean;
  onChange: (showResolved: boolean) => void;
  openLabel: string;
  resolvedLabel: string;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <div className={cn("ui-segmented ui-segmented--compact comment-visibility-filter", className)} role="group" aria-label={t`Comment visibility`}>
      {([[false, openLabel], [true, resolvedLabel]] as const).map(([value, label]) => (
        <button
          key={String(value)}
          type="button"
          className="ui-segmented-tab"
          aria-pressed={showResolved === value}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
