import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { PanelHeader } from "./components/ui/panel-header";
import { SearchField } from "./components/ui/search-field";

export type ProjectFindHit = {
  kind: string;
  path: string;
  title: string;
  snippet: string;
  line?: number | null;
  fileKind?: string | null;
};

export function ProjectFindDialog(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  hits: ProjectFindHit[];
  onClose: () => void;
  onSearch: (query: string) => void;
  onOpenHit: (path: string, line?: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [debouncing, setDebouncing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const onSearchRef = useRef(props.onSearch);
  onSearchRef.current = props.onSearch;

  useEffect(() => {
    if (!props.open) return;
    setActiveIndex(0);
  }, [props.hits, props.open]);

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
  }, [props.open, query]);

  const fileHits = useMemo(
    () => props.hits.filter((hit) => hit.kind === "file"),
    [props.hits],
  );
  const paperHits = useMemo(
    () => props.hits.filter((hit) => hit.kind === "paper"),
    [props.hits],
  );

  const close = () => {
    setDebouncing(false);
    setQuery("");
    onSearchRef.current("");
    props.onClose();
  };

  if (!props.open) return null;

  const openActive = () => {
    if (!query.trim() || debouncing || props.busy || props.error) return;
    const hit = fileHits[activeIndex] ?? paperHits[0];
    if (!hit) return;
    if (hit.kind === "file") {
      props.onOpenHit(hit.path, hit.line ?? undefined);
    }
  };
  const clearSearch = () => {
    setDebouncing(false);
    setQuery("");
    inputRef.current?.focus();
  };
  const searching = debouncing || props.busy;
  const hasResults = fileHits.length > 0 || paperHits.length > 0;
  const showResults = Boolean(query.trim()) && !searching && !props.error;

  return (
    <div className="drawer-backdrop" onMouseDown={close}>
      <aside
        className="project-replace project-find"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Find in project"
      >
        <PanelHeader
          className="drawer-header"
          icon={<Search size={16} />}
          title="Find in project"
          onClose={close}
        />
        <p className="drawer-copy">
          Search `.tex`, `.bib`, and other source files with an indexed full-text index. Enter opens the selected hit; F3 / ⇧F3 cycles.
        </p>
        <label>
          Query
          <SearchField
            ref={inputRef}
            autoFocus
            aria-label="Find in project"
            value={query}
            onChange={(event) => {
              setDebouncing(Boolean(event.target.value.trim()));
              setQuery(event.target.value);
            }}
            onClear={clearSearch}
            placeholder="Phrase or tokens"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(fileHits.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                openActive();
                return;
              }
              if (event.key === "F3") {
                event.preventDefault();
                if (!query.trim() || searching || props.error) return;
                setActiveIndex((index) => {
                  if (!fileHits.length) return 0;
                  const next = event.shiftKey
                    ? (index - 1 + fileHits.length) % fileHits.length
                    : (index + 1) % fileHits.length;
                  const hit = fileHits[next];
                  if (hit) props.onOpenHit(hit.path, hit.line ?? undefined);
                  return next;
                });
              }
            }}
          />
        </label>
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        <div className="project-replace-preview">
          <div
            className="project-replace-preview-summary"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {!query.trim()
              ? "Type to search the project."
              : props.error
                ? "Search failed."
              : searching
                ? "Searching…"
                : `${fileHits.length} hit${fileHits.length === 1 ? "" : "s"}${
                  paperHits.length ? ` · ${paperHits.length} paper${paperHits.length === 1 ? "" : "s"}` : ""
                }`}
          </div>
          {query.trim() && !searching && !props.error && !hasResults && (
            <EmptyState
              align="start"
              density="compact"
              title={`No results for “${query.trim()}”`}
              description="Try a shorter phrase or different terms."
              actions={<Button size="compact" variant="secondary" onClick={clearSearch}>Clear search</Button>}
            />
          )}
          {showResults && fileHits.length > 0 && (
            <ul className="project-replace-hits">
              {fileHits.map((hit, index) => (
                <li key={`${hit.path}:${hit.line ?? 0}:${index}:${hit.snippet}`}>
                  <button
                    type="button"
                    className={`project-replace-hit ${index === activeIndex ? "active" : ""}`}
                    onClick={() => {
                      setActiveIndex(index);
                      props.onOpenHit(hit.path, hit.line ?? undefined);
                    }}
                  >
                    <span className="project-find-hit-heading">
                      <span className="project-find-result-type">
                        {hit.fileKind ? `${hit.fileKind.toLocaleUpperCase()} file` : "File"}
                      </span>
                      <span className="project-replace-hit-path">
                        {hit.path}{hit.line ? `:${hit.line}` : ""}
                      </span>
                    </span>
                    <span className="project-replace-hit-preview">{hit.snippet || hit.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {showResults && paperHits.length > 0 && (
            <div className="project-find-papers">
              <div className="project-replace-preview-summary">Papers</div>
              <ul className="project-replace-hits">
                {paperHits.map((hit) => (
                  <li key={`paper:${hit.path}:${hit.title}`}>
                    <div className="project-replace-hit">
                      <span className="project-find-hit-heading">
                        <span className="project-find-result-type">Paper</span>
                        <span className="project-replace-hit-path">{hit.title}</span>
                      </span>
                      <span className="project-replace-hit-preview">{hit.snippet || hit.path}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="table-generator-actions">
          <Button variant="ghost" onClick={close}>Close</Button>
          <Button
            variant="primary"
            disabled={!fileHits.length || !showResults}
            onClick={openActive}
          >
            Open hit
          </Button>
        </div>
      </aside>
    </div>
  );
}
