import { useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { useLingui } from "@lingui/react/macro";
import { Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
  localSemanticStatusLabel,
  type LocalSemanticSearchStatus,
} from "./project-semantic-search";
import { useCompositionGuard } from "./use-composition-guard";

export type ProjectFindHit = {
  kind: string;
  path: string;
  title: string;
  snippet: string;
  line?: number | null;
  fileKind?: string | null;
  /** True only for a vector-only result with no FTS line hit. */
  semantic?: boolean;
};

function resultType(hit: ProjectFindHit): string {
  if (hit.kind === "paper") return hit.semantic ? "Paper · semantic" : "Paper";
  if (hit.semantic) return "Semantic match";
  return hit.fileKind ? `${hit.fileKind.toLocaleUpperCase()} file` : "File";
}

export function ProjectFindDialog(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  hits: ProjectFindHit[];
  semanticEnabled?: boolean;
  semanticStatus?: LocalSemanticSearchStatus;
  onClose: () => void;
  onSearch: (query: string) => void;
  onOpenHit: (path: string, line?: number) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [debouncing, setDebouncing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { compositionProps, isComposing } = useCompositionGuard();
  // Kept out of the debounce effect's deps so a new callback identity does not
  // restart the timer mid-typing.
  const onSearchRef = useLatestRef(props.onSearch);

  // New hits, or reopening, start again from the first hit.
  const resetKey = props.open ? props.hits : null;
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setActiveIndex(0);
  }

  useEffect(() => {
    if (!props.open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      onSearchRef.current("");
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncing(false);
      onSearchRef.current(trimmed);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [onSearchRef, props.open, query]);

  const fileHits = useMemo(() => props.hits.filter((hit) => hit.kind === "file"), [props.hits]);
  const paperHits = useMemo(() => props.hits.filter((hit) => hit.kind === "paper"), [props.hits]);
  const selectableHits = [...fileHits, ...paperHits];

  const close = () => {
    setDebouncing(false);
    setQuery("");
    onSearchRef.current("");
    props.onClose();
  };

  if (!props.open) return null;

  const searching = debouncing || props.busy;
  const showResults = Boolean(query.trim()) && !searching && !props.error;
  const openHit = (index: number) => {
    const hit = selectableHits[index];
    if (hit) props.onOpenHit(hit.path, hit.line ?? undefined);
  };
  const clearSearch = () => {
    setDebouncing(false);
    setQuery("");
    inputRef.current?.focus();
  };
  const renderHits = (hits: ProjectFindHit[], offset: number) => (
    <ScrollArea className="project-find-results">
      <ul className="project-replace-hits">
        {hits.map((hit, index) => {
          const paper = hit.kind === "paper";
          return (
            <li key={paper ? `paper:${hit.path}:${hit.title}` : `${hit.path}:${hit.line ?? 0}:${index}:${hit.snippet}`}>
              <button
                type="button"
                className={`project-replace-hit ${offset + index === activeIndex ? "active" : ""}`}
                aria-label={paper ? `Open paper result: ${hit.title}` : undefined}
                onClick={() => {
                  setActiveIndex(offset + index);
                  props.onOpenHit(hit.path, hit.line ?? undefined);
                }}
              >
                <span className="project-find-hit-heading">
                  <span className="project-find-result-type">{resultType(hit)}</span>
                  <span className="project-replace-hit-path">
                    {paper ? hit.title : <>{hit.path}{hit.line ? `:${hit.line}` : ""}</>}
                  </span>
                </span>
                <span className="project-replace-hit-preview">{hit.snippet || (paper ? hit.path : hit.title)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );

  return (
    <div className="drawer-backdrop" onMouseDown={close}>
      <aside
        className="project-replace project-find"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={t`Find in project`}
      >
        <PanelHeader
          className="drawer-header"
          icon={<Search size={16} />}
          title={t`Find in project`}
          onClose={close}
        />
        <SearchField
          ref={inputRef}
          autoFocus
          aria-label={t`Find in project`}
          value={query}
          onChange={(event) => {
            setDebouncing(Boolean(event.target.value.trim()));
            setQuery(event.target.value);
          }}
          onClear={clearSearch}
          placeholder="Phrase or tokens"
          {...compositionProps}
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            const count = selectableHits.length;
            switch (event.key) {
              case "Escape":
                close();
                break;
              case "ArrowDown":
                setActiveIndex((index) => Math.min(index + 1, Math.max(count - 1, 0)));
                break;
              case "ArrowUp":
                setActiveIndex((index) => Math.max(index - 1, 0));
                break;
              case "Enter":
                if (event.metaKey || event.ctrlKey) return;
                if (showResults) openHit(activeIndex);
                break;
              case "F3":
                // F3 / Shift-F3 step through the hits, opening each one.
                if (showResults && count) {
                  const next = (activeIndex + (event.shiftKey ? count - 1 : 1)) % count;
                  setActiveIndex(next);
                  openHit(next);
                }
                break;
              default:
                return;
            }
            event.preventDefault();
          }}
        />
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        <div className="project-replace-preview">
          <div
            className="project-replace-preview-summary"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {!query.trim()
              ? null
              : props.error
                ? "Search failed."
              : searching
                ? "Searching…"
                : `${fileHits.length} hit${fileHits.length === 1 ? "" : "s"}${
                  paperHits.length ? ` · ${paperHits.length} paper${paperHits.length === 1 ? "" : "s"}` : ""
                }`}
            {props.semanticEnabled && (
              <span className="project-find-semantic-status">
                {localSemanticStatusLabel(
                  props.semanticStatus ?? DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
                )}
              </span>
            )}
          </div>
          {showResults && !selectableHits.length && (
            <EmptyState
              align="start"
              density="compact"
              title={`No results for “${query.trim()}”`}
              description="Try a shorter phrase or different terms"
              actions={<Button size="compact" variant="secondary" onClick={clearSearch}>Clear search</Button>}
            />
          )}
          {showResults && fileHits.length > 0 && renderHits(fileHits, 0)}
          {showResults && paperHits.length > 0 && (
            <div className="project-find-papers">
              <div className="project-replace-preview-summary">Papers</div>
              {renderHits(paperHits, fileHits.length)}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
