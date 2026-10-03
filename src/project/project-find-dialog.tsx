import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { Trans, useLingui } from "@lingui/react/macro";
import { Search } from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { SegmentedControl } from "../components/ui/segmented-control";
import { ScrollArea } from "../components/ui/scroll-area";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { fileIcon } from "../trellis/trellis-icons";
import { useCompositionGuard } from "./use-composition-guard";

export type ProjectFindHit = {
  kind: string;
  path: string;
  title: string;
  snippet: string;
  line?: number | null;
  fileKind?: string | null;
};

/** Which results show: the search always runs over both, so switching never searches again. */
type FindScope = "all" | "file" | "paper";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** The snippet with each query term marked, so the eye lands on why it matched. */
function markTerms(text: string, query: string) {
  const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 1))];
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, index) => (index % 2 ? <mark key={index}>{part}</mark> : part));
}

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
  // Kept across reopening, like the query.
  const [scope, setScope] = useState<FindScope>("all");
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
  // Each source has its own result limit on the backend, so hiding one loses
  // nothing from the other: a scope filters what was found, and its count
  // still shows what the other scope holds.
  const shownFileHits = scope === "paper" ? [] : fileHits;
  const shownPaperHits = scope === "file" ? [] : paperHits;
  const selectableHits = [...shownFileHits, ...shownPaperHits];
  // One paper can match several times (title, overview and full-text lines);
  // the summary counts papers, so count each library key once. Titles are not
  // unique: a preprint and its published version can share one.
  const paperCount = new Set(paperHits.map((hit) => /^\.research\/papers\/[^/]+\//.exec(hit.path)?.[0] ?? hit.path)).size;
  // The object form, not an interpolated tagged template: the React Compiler
  // bails out on the latter (react-compiler-guard.test.ts).
  const countHits = (count: number) => (count === 1 ? t`1 hit` : t({ message: `${count} hits` }));
  const countPapers = (count: number) => (count === 1 ? t`1 paper` : t({ message: `${count} papers` }));
  const resultSummary = scope === "file"
    ? countHits(fileHits.length)
    : scope === "paper"
      ? countPapers(paperCount)
      : paperCount ? `${countHits(fileHits.length)} · ${countPapers(paperCount)}` : countHits(fileHits.length);

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
  const changeScope = (next: FindScope) => {
    setScope(next);
    setActiveIndex(0);
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
          const paperTitle = hit.title;
          return (
            <li key={`${hit.kind}:${hit.path}:${hit.line ?? 0}:${index}:${hit.snippet}`}>
              <button
                type="button"
                className={`project-replace-hit ${offset + index === activeIndex ? "active" : ""}`}
                aria-label={paper ? t`Open paper result: ${paperTitle}` : undefined}
                title={paper ? undefined : `${hit.path}${hit.line ? `:${hit.line}` : ""}`}
                onClick={() => {
                  setActiveIndex(offset + index);
                  props.onOpenHit(hit.path, hit.line ?? undefined);
                }}
              >
                {/* The icon says what kind of result it is; the name leads, its
                    folder and line follow it, quieter. */}
                <span className="project-find-hit-icon" aria-hidden="true">{fileIcon(hit.path, paper ? "paper" : "file")}</span>
                <span className="project-find-hit-heading">
                  {paper ? (
                    <span className="project-find-hit-name">{hit.title}</span>
                  ) : (
                    <>
                      <span className="project-find-hit-name">{fileName(hit.path)}</span>
                      {folderOf(hit.path) && <span className="project-find-hit-folder">{folderOf(hit.path)}</span>}
                      {hit.line ? <span className="project-find-hit-line">{hit.line}</span> : null}
                    </>
                  )}
                </span>
                <span className="project-replace-hit-preview">
                  {hit.snippet ? markTerms(hit.snippet, query) : paper ? hit.path : hit.title}
                </span>
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
        placeholder={scope === "file" ? t`Search files` : scope === "paper" ? t`Search saved papers` : t`Search files and papers`}
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
      <div className="project-find-scope">
        <SegmentedControl
          value={scope}
          onChange={changeScope}
          ariaLabel={t`Show results from`}
          items={[
            { value: "all", label: <>{t`All`}{showResults && <em>{fileHits.length + paperCount}</em>}</> },
            { value: "file", label: <>{t`Files`}{showResults && <em>{fileHits.length}</em>}</> },
            { value: "paper", label: <>{t`Papers`}{showResults && <em>{paperCount}</em>}</> },
          ]}
        />
        {/* The tabs carry the counts; this line speaks them, and shows only
            what they cannot: that a search is running or failed. */}
        <div
          className={`project-find-status${showResults ? " sr-only" : ""}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {!trimmedQuery ? null : props.error ? t`Search failed.` : searching ? t`Searching…` : resultSummary}
        </div>
      </div>
      <div className="project-replace-preview">
        {!trimmedQuery && (
          <EmptyState
            className="project-find-hint"
            align="start"
            density="compact"
            description={scope === "file"
              ? t`Search the text and names of your project files.`
              : scope === "paper"
                ? t`Search the papers saved in this project.`
                : t`Search your files and saved papers.`}
          />
        )}
        {showResults && !selectableHits.length && (
          fileHits.length + paperHits.length ? (
            <EmptyState
              align="start"
              density="compact"
              icon={<EmptyIllustration kind="search" size="compact" />}
              title={scope === "file" ? t`No files match “${trimmedQuery}”` : t`No papers match “${trimmedQuery}”`}
              actions={<Button size="compact" variant="secondary" onClick={() => changeScope("all")}><Trans>Show all results</Trans></Button>}
            />
          ) : (
            <EmptyState
              align="start"
              density="compact"
              icon={<EmptyIllustration kind="search" size="compact" />}
              title={t`No results for “${trimmedQuery}”`}
              description={t`Try a shorter phrase or different terms`}
              actions={<Button size="compact" variant="secondary" onClick={clearSearch}><Trans>Clear search</Trans></Button>}
            />
          )
        )}
        {showResults && shownFileHits.length > 0 && renderHits(shownFileHits, 0)}
        {showResults && shownPaperHits.length > 0 && (
          scope === "paper" ? renderHits(shownPaperHits, 0) : (
            <div className="project-find-papers">
              <div className="project-replace-preview-summary"><Trans>Papers</Trans></div>
              {renderHits(shownPaperHits, shownFileHits.length)}
            </div>
          )
        )}
      </div>
    </SheetDialog>
  );
}
