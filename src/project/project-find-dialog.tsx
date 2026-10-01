import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { Trans, useLingui } from "@lingui/react/macro";
import { Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { ScrollArea } from "../components/ui/scroll-area";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { useCompositionGuard } from "./use-composition-guard";

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
    // Reopening keeps the last query and runs it again; until that search
    // answers, show it as searching rather than as a query with no results.
    if (seenResetKey === null && query.trim()) setDebouncing(true);
    setSeenResetKey(resetKey);
    setActiveIndex(0);
  }

  // The kept query comes back selected: Enter repeats it, typing replaces it.
  // Selected when the input mounts, not in an effect on `open`: the dialog's
  // portal mounts its content a commit later, so the ref is still empty then.
  const attachInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.select();
  }, []);

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
  // One paper can match several times (title, overview and full-text lines);
  // the summary counts papers, so count each library key once. Titles are not
  // unique: a preprint and its published version can share one.
  const paperCount = new Set(paperHits.map((hit) => /^\.research\/papers\/[^/]+\//.exec(hit.path)?.[0] ?? hit.path)).size;
  // The object form, not an interpolated tagged template: the React Compiler
  // bails out on the latter (react-compiler-guard.test.ts).
  const countHits = (count: number) => (count === 1 ? t`1 hit` : t({ message: `${count} hits` }));
  const countPapers = (count: number) => (count === 1 ? t`1 paper` : t({ message: `${count} papers` }));

  const close = () => {
    setDebouncing(false);
    onSearchRef.current("");
    props.onClose();
  };

  if (!props.open) return null;

  const searching = debouncing || props.busy;
  const trimmedQuery = query.trim();
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
  const resultType = (hit: ProjectFindHit): string => {
    if (hit.kind === "paper") return t`Paper`;
    if (!hit.fileKind) return t`File`;
    const format = hit.fileKind.toLocaleUpperCase();
    return t`${format} file`;
  };
  const renderHits = (hits: ProjectFindHit[], offset: number) => (
    <ScrollArea className="project-find-results">
      <ul className="project-replace-hits">
        {hits.map((hit, index) => {
          const paper = hit.kind === "paper";
          const paperTitle = hit.title;
          return (
            <li key={paper ? `paper:${hit.path}:${hit.title}` : `${hit.path}:${hit.line ?? 0}:${index}:${hit.snippet}`}>
              <button
                type="button"
                className={`project-replace-hit ${offset + index === activeIndex ? "active" : ""}`}
                aria-label={paper ? t`Open paper result: ${paperTitle}` : undefined}
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
    <SheetDialog className="project-replace project-find" label={t`Find in project`} onClose={close}>
      <PanelHeader
        className="drawer-header"
        icon={<Search size={16} />}
        title={t`Find in project`}
        onClose={close}
      />
      <SearchField
        ref={attachInput}
        autoFocus
        aria-label={t`Find in project`}
        value={query}
        onChange={(event) => {
          setDebouncing(Boolean(event.target.value.trim()));
          setQuery(event.target.value);
        }}
        onClear={clearSearch}
        placeholder={t`Phrase or tokens`}
        {...compositionProps}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          const count = selectableHits.length;
          switch (event.key) {
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
              ? t`Search failed.`
            : searching
              ? t`Searching…`
              : paperCount
                ? `${countHits(fileHits.length)} · ${countPapers(paperCount)}`
                : countHits(fileHits.length)}
        </div>
        {showResults && !selectableHits.length && (
          <EmptyState
            align="start"
            density="compact"
            icon={<EmptyIllustration kind="search" size="compact" />}
            title={t`No results for “${trimmedQuery}”`}
            description={t`Try a shorter phrase or different terms`}
            actions={<Button size="compact" variant="secondary" onClick={clearSearch}><Trans>Clear search</Trans></Button>}
          />
        )}
        {showResults && fileHits.length > 0 && renderHits(fileHits, 0)}
        {showResults && paperHits.length > 0 && (
          <div className="project-find-papers">
            <div className="project-replace-preview-summary"><Trans>Papers</Trans></div>
            {renderHits(paperHits, fileHits.length)}
          </div>
        )}
      </div>
    </SheetDialog>
  );
}
