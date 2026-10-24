import { useLingui } from "@lingui/react/macro";
import { CircleAlert } from "lucide-react";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import type { PaperLibraryProps } from "./paper-library";
import type { usePaperTextSearch } from "./paper-library-search";

/**
 * The library while its list is not there yet: one quiet line where the rows
 * will be, on their icon gutter, or why the read failed and a retry. Never
 * the empty library's invitation, which would say a library being read is
 * empty.
 */
export function PaperLoadStatus({ load, syncing, onRetry }: {
  load: PaperLibraryProps["load"];
  syncing: boolean;
  onRetry?: () => void;
}) {
  const { t } = useLingui();
  if (load?.status === "error") {
    return (
      <div className="papers-load-status" data-state="error" role="status">
        <CircleAlert size={14} className="papers-load-icon" aria-hidden="true" />
        <span className="papers-load-text">
          <strong>{t`Couldn’t read your references`}</strong>
          <span className="papers-load-detail" title={load.error}>{load.error}</span>
        </span>
        {onRetry && <Button size="compact" onClick={onRetry}>{t`Try again`}</Button>}
      </div>
    );
  }
  return (
    <div className="papers-load-status" role="status">
      <span className="papers-load-icon"><InfinityLoader size={12} /></span>
      <span className="papers-load-text">{syncing ? t`Syncing references…` : t`Loading references…`}</span>
    </div>
  );
}

/**
 * Where the full-text half of a search has got, above what it found: the
 * list shows metadata matches at once, and a slow or failed pass over the
 * saved text says so, so a short list (or none) is not read as the library
 * lacking the paper. A quick pass, the usual case, never shows this.
 */
export function PaperTextSearchStatus({ search }: { search: ReturnType<typeof usePaperTextSearch> }) {
  const { t } = useLingui();
  if (search.status === "failed") {
    const label = t`Saved-text search unavailable`;
    return (
      <div className="paper-text-search" data-state="failed" role="status">
        <CircleAlert size={13} className="paper-add-icon" aria-hidden="true" />
        <span className="paper-text-search-text" title={search.error ? `${label}\n${search.error}` : label}>{label}</span>
        <Button size="compact" onClick={search.retry}>{t`Try again`}</Button>
      </div>
    );
  }
  if (search.status !== "searching") return null;
  return (
    <div className="paper-text-search" role="status">
      <span className="paper-add-icon"><InfinityLoader size={12} /></span>
      <span className="paper-text-search-text">{t`Searching saved text…`}</span>
    </div>
  );
}
