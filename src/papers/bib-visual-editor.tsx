/**
 * A .bib file's visual form: its references as a searchable list, and the one
 * in front as a form whose every field edits the file in place.
 *
 * The list reads the text through `bib-document.ts`, and every change is a
 * splice into the file's current text, found again by the entry's key at the
 * moment the change is made (the list may be drawn from a deferred copy), and
 * handed to the host as the file's next text: untouched entries, comments and
 * macros never move, and
 * the host's undo history (the source editor's, when it is mounted) records
 * the change like any other edit. A text the parser cannot read whole is never
 * edited here; the canvas shows its source instead (see `bibUnreadableReason`).
 *
 * Thousands of entries stay quick: the list draws only the rows in view, all
 * rows one fixed height (a taller one when the list is narrow enough to stack
 * a row's lines), and parses a deferred copy of the text, so typing in the
 * source beside it never waits for the list.
 */
import {
  useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { ArrowDownUp, ArrowLeft, BookOpen, Check, Code2, ExternalLink, ListFilter, Plus, Trash2, X } from "lucide-react";
import type { PaperSummary } from "../app-types";
import { useLatestRef } from "../hooks/use-latest-ref";
import { CopyButton } from "../components/copy-button";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { ListTool } from "../components/ui/list-tool";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { resizeTextareaToContent } from "../components/ui/auto-resize-textarea";
import { notifySuccess } from "../telemetry/app-notify";
import { toMessage } from "../app-utils";
import { formatCount } from "../i18n";
import { BIB_LIST_RATIO_DEFAULT, clamp, loadBibListRatio, persistBibListRatio } from "../settings/app-settings";
import type { SymbolOccurrence } from "../project/references-panel";
import { appendBibEntry, formatBibEntry } from "./bib-entry";
import { BibEntryDialog, type ResolvedCitationDraft } from "./bib-entry-dialog";
import {
  addFieldEdit, applyBibEdit, bibUnreadableReason, changeTypeEdit, deleteEntryEdit, editableValue, encodeValue,
  readBibDocument, removeFieldEdit, renameKeyEdit, replaceValueEdit, summarizeEntries, validCitationKey,
  type BibEdit, type BibEntry, type BibField, type BibParseError, type BibSummary,
} from "./bib-document";
import "./bib-visual-editor.css";

/** The reference last in front in each file, for the next list of it. */
const selectedByPath = new Map<string, string>();

/** Every row is this tall, so the list knows which rows are in view without measuring them. */
const ROW_HEIGHT = 60;
/**
 * A list this narrow (the narrowest panel, or the list beside the reference)
 * has no room for the year's margin: each row stacks title, byline and key on
 * three lines, and is this tall so they keep their leading.
 */
const NARROW_LIST_WIDTH = 380;
const NARROW_ROW_HEIGHT = 80;
/** The list and the reference beside it never get narrower than these, however the divider is dragged. */
const LIST_MIN_WIDTH = 240;
const DETAIL_MIN_WIDTH = 320;
/** One arrow key's move of the divider, as a share of the width. */
const DIVIDER_STEP = 0.03;
/** Rows drawn beyond each edge of the view, so a fast scroll does not show blank rows. */
const OVERSCAN = 8;
/**
 * The view may scroll this close to either end of the rows drawn before they
 * are drawn again around it: a scroll re-renders the list once every few
 * rows, not on every frame.
 */
const REDRAW_MARGIN = 2;

/** The types the type menu offers; an entry of another type keeps it and lists it too. */
const ENTRY_TYPES = [
  "article", "inproceedings", "book", "incollection", "inbook", "proceedings", "phdthesis", "mastersthesis",
  "techreport", "misc", "online", "unpublished", "manual", "booklet",
];

/** Fields whose values run long enough for a box that wraps. */
const LONG_FIELDS = new Set(["title", "author", "editor", "abstract", "note", "annote", "annotation", "keywords", "booktitle", "journal"]);

export type BibVisualEditorProps = {
  path: string;
  source: string;
  projectRoot: string;
  editable: boolean;
  papers: PaperSummary[];
  /** Changes whenever the manuscript may cite differently (each save); the citation scan runs again. */
  usageRevision: unknown;
  /** Make `next` the file's text. It was computed from `base`; false when the text has moved on since. */
  onChange: (next: string, base: string) => boolean;
  onUndo: () => boolean;
  onRedo: () => boolean;
  /** Show 1-based `line` of `path` in its source. */
  onOpenLine: (path: string, line: number) => void;
  onOpenPaper: (paper: PaperSummary) => void;
  onOpenUrl: (url: string) => void;
  onResolveCitation: (query: string) => Promise<ResolvedCitationDraft>;
};

type Filter = "all" | "cited" | "unused";
type Sort = "file" | "year" | "author" | "title";
type Row = { entry: BibEntry; summary: BibSummary; index: number };
type Usages = { byKey: Map<string, SymbolOccurrence[]>; everything: boolean };
/** A change to one entry, measured on `source` with `entry` as found there; falsy makes none. */
type EntryEdit = (source: string, entry: BibEntry) => BibEdit | null | false | undefined;
type Committed = { next: string; base: string; change: BibEdit };

/** Leave a field (which writes it) for the editor around it, so its keys (⌘Z) still apply. */
const leaveField = (field: HTMLElement) => field.closest<HTMLElement>(".bib-visual")?.focus();

/** `entry` still has `field` (by name) at `index`. */
const sameField = (entry: BibEntry, index: number, field: BibField) => entry.fields[index]?.name === field.name;

const sameKey = (a: string | undefined, b: string) => a?.toLocaleLowerCase() === b.toLocaleLowerCase();

/** The rows drawn for a view `height` tall scrolled to `top`: those in it and OVERSCAN either side. */
function drawnRows(top: number, height: number, rowHeight: number, count: number) {
  return {
    first: Math.max(0, Math.floor(top / rowHeight) - OVERSCAN),
    last: Math.min(count, Math.ceil((top + height) / rowHeight) + OVERSCAN),
  };
}

/** The key of the last entry in `source`, such as one just appended. */
const lastEntryKey = (source: string) => readBibDocument(source).document?.entries.at(-1)?.key;

function groupUsages(list: SymbolOccurrence[]): Usages {
  const byKey = new Map<string, SymbolOccurrence[]>();
  let everything = false;
  for (const usage of list) {
    if (usage.symbol === "*") {
      everything = true;
      continue;
    }
    const key = usage.symbol.toLocaleLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), usage]);
  }
  return { byKey, everything };
}

/** The first surname of an author list, for sorting by author. */
function sortSurname(summary: BibSummary): string {
  return summary.authors.split(",")[0]?.trim().split(/\s+/).pop()?.toLocaleLowerCase() ?? "";
}

export function BibVisualEditor(props: BibVisualEditorProps) {
  const { t } = useLingui();
  const { onChange, onUndo, onRedo } = props;
  // The file as it is now, for edits and for a toast's Undo long after the render that raised it.
  const latestRef = useLatestRef(props);
  // A deferred copy: typing in the source beside the list re-reads the file
  // only when React has time.
  const text = useDeferredValue(props.source);
  const parse = readBibDocument(text);
  const document = parse.document;
  const readable = document !== null;
  const rows = useMemo<Row[]>(() => {
    if (!document) return [];
    const summaries = summarizeEntries(text, document);
    return document.entries.map((entry, index) => ({ entry, index, summary: summaries[index] }));
  }, [document, text]);

  // ---- Where the manuscript cites each key.
  const [usages, setUsages] = useState<Usages | null>(null);
  useEffect(() => {
    let disposed = false;
    invoke<SymbolOccurrence[]>("list_citation_usages")
      .then((list) => { if (!disposed) setUsages(groupUsages(list)); })
      // Without the scan nothing is flagged unused, rather than everything.
      .catch(() => { if (!disposed) setUsages(null); });
    return () => { disposed = true; };
  }, [props.projectRoot, props.usageRevision]);
  const usageOf = useCallback((key: string) => usages?.byKey.get(key.toLocaleLowerCase()) ?? [], [usages]);
  const isUnused = useCallback((key: string) => Boolean(usages && !usages.everything && !usages.byKey.has(key.toLocaleLowerCase())), [usages]);

  // ---- What the list shows.
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("file");
  const counts = useMemo(() => {
    const unused = rows.filter((row) => isUnused(row.entry.key)).length;
    return { all: rows.length, unused, cited: usages ? rows.length - unused : rows.length };
  }, [isUnused, rows, usages]);
  const shown = useMemo(() => {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matching = rows.filter((row) => (
      (filter === "all" || (filter === "unused") === isUnused(row.entry.key))
      && terms.every((term) => row.summary.haystack.includes(term))
    ));
    if (sort === "file") return matching;
    const compare = sort === "year"
      ? (a: Row, b: Row) => b.summary.year.localeCompare(a.summary.year)
      : sort === "author"
        ? (a: Row, b: Row) => sortSurname(a.summary).localeCompare(sortSurname(b.summary))
        : (a: Row, b: Row) => a.summary.title.localeCompare(b.summary.title);
    return [...matching].sort((a, b) => compare(a, b) || a.index - b.index);
  }, [filter, isUnused, query, rows, sort]);

  // ---- The entry in front, by key: offsets move with every edit, keys do not.
  // Switching Preview and Split mounts a new list, which comes back to it.
  const [selectedKey, setSelectedKey] = useState<string | null>(() => selectedByPath.get(props.path) ?? null);
  useEffect(() => {
    if (selectedKey === null) selectedByPath.delete(props.path);
    else selectedByPath.set(props.path, selectedKey);
  }, [props.path, selectedKey]);
  const [detailOpen, setDetailOpen] = useState(false);
  const selected = (selectedKey !== null ? rows.find((row) => row.entry.key === selectedKey) : undefined)
    ?? (selectedKey !== null ? rows.find((row) => sameKey(row.entry.key, selectedKey)) : undefined);
  const selectedIndex = selected ? shown.indexOf(selected) : -1;

  // ---- Editing.
  const lastDeleteRef = useRef<{ text: string; removed: string; at: number; key: string } | null>(null);
  /**
   * Make `edit` of the entry `row` stands for, against the file as it is now:
   * the list may still be drawn from an older copy, so the entry is found
   * again (where it was, else by its key) and the splice measured on that.
   */
  const editEntry = useCallback((row: Row, edit: EntryEdit): Committed | null => {
    const base = latestRef.current.source;
    const entries = readBibDocument(base).document?.entries;
    const entry = entries?.[row.index]?.key === row.entry.key ? entries[row.index] : entries?.find((item) => item.key === row.entry.key);
    const change = entry && edit(base, entry);
    if (!change) return null;
    const next = applyBibEdit(base, change);
    return next !== base && latestRef.current.onChange(next, base) ? { next, base, change } : null;
  }, [latestRef]);

  const select = (key: string, open = true) => {
    setSelectedKey(key);
    if (open) setDetailOpen(true);
  };
  // An entry this editor put back or added (or the one remembered) comes into view once the list has it.
  const [revealKey, setRevealKey] = useState<string | null>(selectedKey);
  const bringBack = (key: string) => {
    select(key);
    setRevealKey(key);
  };

  const deleteEntry = (row: Row) => {
    const committed = editEntry(row, deleteEntryEdit);
    if (committed === null) return;
    const { next, base, change } = committed;
    const neighbour = shown[shown.indexOf(row) + 1] ?? shown[shown.indexOf(row) - 1];
    setSelectedKey(neighbour?.entry.key ?? null);
    const deleted = { text: next, removed: base.slice(change.from, change.to), at: change.from, key: row.entry.key };
    lastDeleteRef.current = deleted;
    const cited = usageOf(row.entry.key).length;
    const key = row.entry.key;
    notifySuccess(t`Bibliography`, t`Deleted “${key}”`, {
      detail: cited ? t`It is still cited in the manuscript (${cited}).` : undefined,
      dedupeKey: `bib-delete:${props.path}:${key}`,
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          if (lastDeleteRef.current !== deleted) return;
          lastDeleteRef.current = null;
          const latest = latestRef.current;
          // Nothing changed since: step the history back, so redo still works.
          if (latest.source === deleted.text && latest.onUndo()) {
            bringBack(deleted.key);
            return;
          }
          const current = latest.source;
          const at = Math.min(deleted.at, current.length);
          if (latest.onChange(`${current.slice(0, at)}${deleted.removed}${current.slice(at)}`, current)) bringBack(deleted.key);
        },
      },
    });
  };

  // ---- Adding.
  const [adding, setAdding] = useState<{ key: number; error: string | null } | null>(null);
  const addEntry = (bibtex: string) => {
    try {
      const base = latestRef.current.source;
      const next = appendBibEntry(base, bibtex);
      if (!onChange(next, base)) return;
      const added = lastEntryKey(next);
      if (added) {
        setQuery("");
        setFilter("all");
        bringBack(added);
      }
      setAdding(null);
    } catch (reason) {
      // Read outside the updater: a catch binding that a closure captures
      // keeps the React Compiler off this whole component, as does a
      // conditional or optional chain inside the try.
      const error = toMessage(reason);
      setAdding((current) => current && { ...current, error });
    }
  };

  // ---- Keyboard: the list moves with the arrows; ⌘Z steps the file's history outside a field.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 });
  const narrow = viewport.width > 0 && viewport.width <= NARROW_LIST_WIDTH;
  const rowHeight = narrow ? NARROW_ROW_HEIGHT : ROW_HEIGHT;
  const revealIndex = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const top = index * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
  };
  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (!shown.length) return;
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    let index: number | null = null;
    if (event.key in step) index = Math.max(0, Math.min(shown.length - 1, (selectedIndex === -1 ? -1 : selectedIndex) + step[event.key]));
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = shown.length - 1;
    else if ((event.key === "Delete" || event.key === "Backspace") && selected && props.editable) {
      event.preventDefault();
      deleteEntry(selected);
      return;
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      setDetailOpen(true);
      return;
    }
    if (index === null) return;
    event.preventDefault();
    select(shown[index].entry.key, false);
    revealIndex(index);
  };
  const onRootKeyDown = (event: ReactKeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z") return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    if (event.shiftKey) onRedo();
    else onUndo();
  };

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // A list hidden behind the reference (a narrow pane) keeps the width it had.
    const measure = () => setViewport((current) => ({ top: list.scrollTop, height: list.clientHeight, width: list.clientWidth || current.width }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [readable]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const index = revealKey === null ? -1 : shown.findIndex((row) => row.entry.key === revealKey);
    if (!list || index === -1) return;
    setRevealKey(null);
    list.scrollTop = Math.max(0, index * rowHeight - (list.clientHeight - rowHeight) / 2);
  }, [revealKey, rowHeight, shown]);
  // A filter that shrinks the list below the scroll position starts it from the top.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && list.scrollTop > shown.length * rowHeight) list.scrollTop = 0;
  }, [rowHeight, shown.length]);

  // ---- The divider between the list and the reference: dragged, or moved
  // with the arrow keys; the share it leaves the list is remembered.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [listRatio, setListRatio] = useState(loadBibListRatio);
  const [resizing, setResizing] = useState(false);
  /** `listWidth` px of the body's columns as a share, held where both sides keep their minimums. */
  const fitListRatio = (listWidth: number) => {
    const tracks = (bodyRef.current?.clientWidth ?? 0) - 1;
    if (tracks <= 0) return listRatio;
    return clamp(listWidth, LIST_MIN_WIDTH, tracks - DETAIL_MIN_WIDTH) / tracks;
  };
  const commitListRatio = (ratio: number) => {
    setListRatio(ratio);
    persistBibListRatio(ratio);
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
  };
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    if (!body || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    // The drag moves the column outside React; letting go commits the same share.
    body.style.setProperty("--bib-list-ratio", String(fitListRatio(event.clientX - body.getBoundingClientRect().left)));
  };
  const endResize = () => {
    const ratio = Number(bodyRef.current?.style.getPropertyValue("--bib-list-ratio"));
    setResizing(false);
    if (Number.isFinite(ratio) && ratio > 0) commitListRatio(ratio);
  };
  const onDividerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const tracks = (bodyRef.current?.clientWidth ?? 0) - 1;
    // From where the divider is drawn, which a narrower pane may have moved off the remembered share.
    const drawn = fitListRatio(listRatio * tracks);
    commitListRatio(fitListRatio((drawn + (event.key === "ArrowLeft" ? -DIVIDER_STEP : DIVIDER_STEP)) * tracks));
  };

  if (parse.error) {
    // The canvas shows the source in place of a list it cannot draw; this is
    // what Split shows beside it. Its own component: to the React Compiler a
    // call here with the error could change the parse the memos above read,
    // which would keep it off this whole component.
    return <UnreadableBibliography error={parse.error} onOpenLine={(line) => props.onOpenLine(props.path, line)} />;
  }

  const { first, last } = drawnRows(viewport.top, viewport.height, rowHeight, shown.length);
  const optionId = (row: Row) => `bib-row-${row.index}`;
  const sortLabels: Record<Sort, string> = { file: t`File order`, year: t`Newest first`, author: t`Author`, title: t`Title` };
  const filterLabels: Record<Filter, string> = { all: t`All`, cited: t`Cited`, unused: t`Unused` };
  const filterTitles: Partial<Record<Filter, string>> = { cited: t`Cited in the manuscript`, unused: t`Not cited in any .tex file` };

  return (
    <div
      className="bib-visual"
      data-detail={detailOpen && selected ? "open" : undefined}
      data-resizing={resizing || undefined}
      // Focusable, so a click anywhere in it keeps the keyboard here: ⌘Z then steps this file's history.
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
    >
      <div className="bib-visual-toolbar">
        <SearchField
          controlSize="compact"
          containerClassName="bib-visual-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          placeholder={t`Search references`}
          aria-label={t`Search references`}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              onListKeyDown(event);
              listRef.current?.focus();
            }
          }}
        />
        {/* Filter and sort as the Papers library sets them: each names what
            it does, then what it is set to; a narrow pane folds them, and
            Add, to their icons. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ListTool
              icon={<ListFilter size={14} aria-hidden="true" />}
              label={t`Filter`}
              value={filter === "all" ? undefined : <>{filterLabels[filter]}<span className="bib-visual-count">{formatCount(counts[filter])}</span></>}
              on={filter !== "all"}
              name={filter === "all" ? t`Show references` : t({ message: `Show references: ${{ filter: filterLabels[filter] }}` })}
              title={t`Show references`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bib-visual-menu">
            {(Object.keys(filterLabels) as Filter[]).map((value) => (
              <DropdownMenuItem key={value} role="menuitemradio" aria-checked={filter === value} title={filterTitles[value]} onSelect={() => setFilter(value)}>
                <span className="bib-visual-menu-check">{filter === value && <Check size={14} />}</span>
                <span className="bib-visual-menu-label">{filterLabels[value]}</span>
                <span className="bib-visual-menu-count">{formatCount(counts[value])}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ListTool
              icon={<ArrowDownUp size={14} aria-hidden="true" />}
              label={t`Sort`}
              value={sortLabels[sort]}
              on={sort !== "file"}
              name={t({ message: `Sort references: ${{ order: sortLabels[sort] }}` })}
              title={t`Sort references`}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bib-visual-menu">
            {(Object.keys(sortLabels) as Sort[]).map((value) => (
              <DropdownMenuItem key={value} role="menuitemradio" aria-checked={sort === value} onSelect={() => setSort(value)}>
                <span className="bib-visual-menu-check">{sort === value && <Check size={14} />}</span>
                <span className="bib-visual-menu-label">{sortLabels[value]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {props.editable && (
          <Button size="compact" variant="secondary" className="bib-visual-add" title={t`Add reference`} onClick={() => setAdding({ key: Date.now(), error: null })}>
            <Plus size={13} aria-hidden="true" />
            <span className="bib-visual-add-label">{t`Add reference`}</span>
          </Button>
        )}
      </div>
      <div
        ref={bodyRef}
        className="bib-visual-body"
        style={{
          "--bib-list-ratio": listRatio,
          "--bib-list-min": `${LIST_MIN_WIDTH}px`,
          "--bib-detail-min": `${DETAIL_MIN_WIDTH}px`,
        } as CSSProperties}
      >
        <ScrollArea
          className="bib-visual-list"
          viewportClassName="bib-visual-list-viewport"
          viewportRef={listRef}
          viewportProps={{
            role: "listbox",
            tabIndex: 0,
            "aria-label": t`References`,
            // Only a drawn row can be named; the arrows scroll the one they reach into view.
            "aria-activedescendant": selected && selectedIndex >= first && selectedIndex < last ? optionId(selected) : undefined,
            "data-narrow": narrow ? "" : undefined,
            onKeyDown: onListKeyDown,
            onScroll: (event) => {
              const { scrollTop, clientHeight } = event.currentTarget;
              // Draw again only once the view nears the end of the rows drawn.
              const view = drawnRows(scrollTop, clientHeight, rowHeight, shown.length);
              const covered = clientHeight === viewport.height
                && (first === 0 || view.first + OVERSCAN - REDRAW_MARGIN >= first)
                && (last === shown.length || view.last - OVERSCAN + REDRAW_MARGIN <= last);
              if (!covered) setViewport({ ...viewport, top: scrollTop, height: clientHeight });
            },
          }}
        >
          {shown.length === 0 ? (
            <EmptyState
              density="compact"
              title={rows.length === 0 ? t`No references yet` : t`No matching references`}
              description={rows.length === 0 && props.editable ? t`Add one by DOI, arXiv ID, title, or by hand` : undefined}
              actions={rows.length === 0 && props.editable
                ? <Button size="compact" variant="secondary" onClick={() => setAdding({ key: Date.now(), error: null })}>{t`Add reference`}</Button>
                : query || filter !== "all"
                  ? <Button size="compact" variant="ghost" onClick={() => { setQuery(""); setFilter("all"); }}>{t`Show all references`}</Button>
                  : undefined}
            />
          ) : (
            <div className="bib-visual-rows" style={{ height: shown.length * rowHeight }}>
              {shown.slice(first, last).map((row, offset) => (
                <BibRow
                  key={row.index}
                  id={optionId(row)}
                  summary={row.summary}
                  citationKey={row.entry.key}
                  selected={row === selected}
                  unused={isUnused(row.entry.key)}
                  citedCount={usageOf(row.entry.key).length}
                  top={(first + offset) * rowHeight}
                  height={rowHeight}
                  onSelect={select}
                />
              ))}
            </div>
          )}
        </ScrollArea>
        <div
          className="bib-visual-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t`Resize reference list and details`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(listRatio * 100)}
          tabIndex={0}
          data-dragging={resizing || undefined}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onLostPointerCapture={endResize}
          onKeyDown={onDividerKeyDown}
          onDoubleClick={() => commitListRatio(BIB_LIST_RATIO_DEFAULT)}
        />
        <div className="bib-visual-detail">
          {selected ? (
            <EntryDetail
              key={selected.entry.key}
              {...props}
              row={selected}
              rows={rows}
              macros={parse.document.macros}
              usages={usages && { list: usageOf(selected.entry.key), everything: usages.everything }}
              parsedText={text}
              edit={(change) => editEntry(selected, change)}
              onRenamed={(key) => setSelectedKey(key)}
              onDelete={() => deleteEntry(selected)}
              onBack={() => {
                setDetailOpen(false);
                listRef.current?.focus();
              }}
            />
          ) : (
            <EmptyState
              density="compact"
              icon={<BookOpen size={20} />}
              title={t`No reference selected`}
              description={t`Choose a reference to see where it is cited and edit its fields`}
            />
          )}
        </div>
      </div>
      {adding && (
        <BibEntryDialog
          key={adding.key}
          open
          busy={false}
          error={adding.error}
          offerCite={false}
          onClose={() => setAdding(null)}
          onResolve={props.onResolveCitation}
          onSave={(draft) => addEntry(formatBibEntry(draft))}
        />
      )}
    </div>
  );
}

function UnreadableBibliography(props: { error: BibParseError; onOpenLine: (line: number) => void }) {
  const { t } = useLingui();
  return (
    <div className="bib-visual" data-state="unreadable">
      <EmptyState
        title={t`This bibliography can't be shown as a list`}
        description={<>{bibUnreadableReason(props.error)} {t`Fix it in the source and the list comes back.`}</>}
        actions={<Button size="compact" variant="secondary" onClick={() => props.onOpenLine(props.error.line)}>{t`Go to the error`}</Button>}
      />
    </div>
  );
}

/**
 * One reference in the list. Its own component, so moving the window of rows
 * drawn renders only the rows it brings in, and a row whose reference, flags
 * and place are unchanged is not drawn again.
 */
function BibRow(props: {
  id: string;
  summary: BibSummary;
  citationKey: string;
  selected: boolean;
  unused: boolean;
  citedCount: number;
  top: number;
  height: number;
  onSelect: (key: string) => void;
}) {
  const { t } = useLingui();
  const { summary, citationKey, citedCount } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      className="bib-row"
      style={{ top: props.top, height: props.height }}
      onClick={() => props.onSelect(citationKey)}
    >
      <span className="bib-row-year">{summary.year}</span>
      <span className="bib-row-title">{summary.title || <em>{t`Untitled`}</em>}</span>
      <span className="bib-row-meta">
        {summary.shortAuthors && <span className="bib-row-authors">{summary.shortAuthors}</span>}
        {summary.venue && <i className="bib-row-venue">{summary.venue}</i>}
      </span>
      {/* The type is left to the detail: a reference list does not set it. */}
      <span className="bib-row-foot">
        <code className="bib-row-key">{citationKey}</code>
        {props.unused
          ? <Badge size="compact" tone="warning" className="bib-row-badge">{t`Unused`}</Badge>
          : citedCount > 0 && (
            <span className="bib-row-cited" title={t`Citations in the manuscript: ${citedCount}`}>
              {/* One dot a citation, up to five; the count says the rest. */}
              <span className="bib-row-dots" aria-hidden="true">
                {Array.from({ length: Math.min(citedCount, 5) }, (_, dot) => <i key={dot} />)}
              </span>
              <span aria-hidden="true">{citedCount}</span>
              <span className="sr-only">{t`Cited ×${citedCount}`}</span>
            </span>
          )}
      </span>
    </div>
  );
}

function EntryDetail(props: BibVisualEditorProps & {
  /** The text `row` was read from, which its offsets measure. */
  parsedText: string;
  row: Row;
  rows: Row[];
  macros: Map<string, string>;
  usages: { list: SymbolOccurrence[]; everything: boolean } | null;
  edit: (change: EntryEdit) => Committed | null;
  onRenamed: (key: string) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const { row, edit, editable } = props;
  const text = props.parsedText;
  const { entry, summary } = row;
  const paper = props.papers.find((item) => sameKey(item.citationKey, entry.key))
    ?? (summary.arxivId ? props.papers.find((item) => item.arxivId === summary.arxivId) : undefined);
  const readablePaper = paper && (paper.hasFullText || paper.hasBlog) ? paper : undefined;
  const doiUrl = summary.doi && /^10\.\d{4,9}\/\S+$/.test(summary.doi) ? `https://doi.org/${summary.doi}` : null;
  const arxivUrl = summary.arxivId ? `https://arxiv.org/abs/${summary.arxivId}` : null;
  const webUrl = /^https?:\/\//i.test(summary.url) && ![arxivUrl, doiUrl].includes(summary.url) ? summary.url : null;
  const keyId = useId();

  const [keyError, setKeyError] = useState<string | null>(null);
  const renameKey = (next: string) => {
    const key = next.trim();
    if (key === entry.key) return setKeyError(null);
    if (!validCitationKey(key)) return setKeyError(t`A citation key cannot be empty or contain spaces, commas, braces, quotes or %.`);
    if (props.rows.some((other) => other !== row && sameKey(other.entry.key, key))) return setKeyError(t`Another reference already uses “${key}”.`);
    setKeyError(null);
    if (edit((_, current) => renameKeyEdit(current, key)) !== null) props.onRenamed(key);
  };
  const types = ENTRY_TYPES.includes(entry.kind) ? ENTRY_TYPES : [entry.kind, ...ENTRY_TYPES];

  const [newField, setNewField] = useState({ name: "", value: "", error: null as string | null });
  const addField = () => {
    const name = newField.name.trim();
    if (!/^[A-Za-z][\w:.+-]*$/.test(name)) return setNewField((current) => ({ ...current, error: t`Field names start with a letter and have no spaces.` }));
    if (entry.fields.some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      return setNewField((current) => ({ ...current, error: t`This reference already has a “${name}” field.` }));
    }
    const raw = encodeValue(newField.value, "brace", props.macros);
    if (raw === null) return setNewField((current) => ({ ...current, error: t`Braces in the value must be balanced.` }));
    if (edit((source, current) => addFieldEdit(source, current, name, raw)) !== null) setNewField({ name: "", value: "", error: null });
  };

  const nociteAll = "\\nocite{*}";
  const usageLabel = props.usages === null ? null
    : props.usages.list.length ? null
      : props.usages.everything ? t`Not cited by key, but ${nociteAll} includes every entry` : t`Not cited in any .tex file`;

  return (
    <ScrollArea className="bib-detail" viewportClassName="bib-detail-viewport">
      <div className="bib-detail-content">
        <button type="button" className="bib-detail-back" onClick={props.onBack}>
          <ArrowLeft size={13} aria-hidden="true" />
          {t`All references`}
        </button>
        <header className="bib-detail-header">
          <div className="bib-detail-identity">
            <Select value={entry.kind} disabled={!editable} onValueChange={(value) => edit((_, current) => changeTypeEdit(current, value))}>
              <SelectTrigger size="compact" aria-label={t`Entry type`} className="bib-detail-type"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                {types.map((value) => <SelectItem key={value} value={value}>{`@${value}`}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="sr-only" htmlFor={keyId}>{t`Citation key`}</label>
            <Input
              key={entry.key}
              id={keyId}
              controlSize="compact"
              className="bib-detail-key"
              defaultValue={entry.key}
              readOnly={!editable}
              aria-invalid={keyError ? true : undefined}
              spellCheck={false}
              onBlur={(event) => renameKey(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") leaveField(event.currentTarget);
                if (event.key === "Escape") {
                  event.currentTarget.value = entry.key;
                  setKeyError(null);
                  leaveField(event.currentTarget);
                }
              }}
            />
            <CopyButton className="bib-detail-copy" text={entry.key} title={t`Copy citation key`} />
          </div>
          {keyError && <InlineMessage level="error" className="bib-detail-error">{keyError}</InlineMessage>}
          <h2 className="bib-detail-title">{summary.title || t`Untitled`}</h2>
          {summary.authors && <p className="bib-detail-authors">{summary.authors}</p>}
          {(summary.venue || summary.year) && <p className="bib-detail-venue">{[summary.venue, summary.year].filter(Boolean).join(" · ")}</p>}
          <div className="bib-detail-actions">
            {readablePaper && (
              <Button size="compact" variant="secondary" onClick={() => props.onOpenPaper(readablePaper)}>
                <BookOpen size={13} aria-hidden="true" />
                {t`Open paper`}
              </Button>
            )}
            {doiUrl && <LinkButton kind="doi" url={doiUrl} onOpen={props.onOpenUrl} />}
            {arxivUrl && <LinkButton kind="arxiv" url={arxivUrl} onOpen={props.onOpenUrl} />}
            {webUrl && <LinkButton kind="web" url={webUrl} onOpen={props.onOpenUrl} />}
            <Button size="compact" variant="ghost" onClick={() => props.onOpenLine(props.path, entry.line)}>
              <Code2 size={13} aria-hidden="true" />
              {t`Show in source`}
            </Button>
            {editable && (
              <Button size="compact" variant="ghost" className="bib-detail-delete" onClick={props.onDelete}>
                <Trash2 size={13} aria-hidden="true" />
                {t`Delete`}
              </Button>
            )}
          </div>
        </header>
        <section className="bib-detail-section" aria-labelledby={`${keyId}-cited`}>
          <h3 id={`${keyId}-cited`}>{t`Cited in`}</h3>
          {props.usages === null && <p className="bib-detail-muted">{t`Looking through the manuscript…`}</p>}
          {usageLabel && <p className="bib-detail-unused">{usageLabel}</p>}
          {props.usages && props.usages.list.length > 0 && (
            <ul className="bib-detail-usages">
              {props.usages.list.map((usage, index) => (
                <li key={`${usage.path}:${usage.line}:${index}`}>
                  <button type="button" onClick={() => props.onOpenLine(usage.path, usage.line)}>
                    <span className="bib-usage-place">{`${usage.path}:${usage.line}`}</span>
                    <span className="bib-usage-snippet">{usage.snippet.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="bib-detail-section" aria-labelledby={`${keyId}-fields`}>
          <h3 id={`${keyId}-fields`}>{t`Fields`}</h3>
          <div className="bib-detail-fields">
            {entry.fields.map((field, index) => (
              <FieldRow
                key={`${index}:${field.name}:${text.slice(field.valueFrom, field.valueTo)}`}
                field={field}
                raw={text.slice(field.valueFrom, field.valueTo)}
                macros={props.macros}
                editable={editable}
                onCommit={(raw) => edit((_, current) => sameField(current, index, field) && replaceValueEdit(current.fields[index], raw))}
                onRemove={() => edit((source, current) => sameField(current, index, field) && removeFieldEdit(source, current, current.fields[index]))}
              />
            ))}
          </div>
          {editable && (
            <form
              className="bib-detail-add-field"
              onSubmit={(event) => {
                event.preventDefault();
                addField();
              }}
            >
              <Input
                controlSize="compact"
                className="bib-add-field-name"
                value={newField.name}
                placeholder={t`Field`}
                aria-label={t`New field name`}
                spellCheck={false}
                onChange={(event) => setNewField({ ...newField, name: event.target.value, error: null })}
              />
              <Input
                controlSize="compact"
                value={newField.value}
                placeholder={t`Value`}
                aria-label={t`New field value`}
                onChange={(event) => setNewField({ ...newField, value: event.target.value, error: null })}
              />
              <Button type="submit" size="compact" variant="secondary" disabled={!newField.name.trim()}>{t`Add field`}</Button>
              {newField.error && <InlineMessage level="error" className="bib-detail-error">{newField.error}</InlineMessage>}
            </form>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

/** An entry's DOI, arXiv abstract or web page, opened in the browser. */
function LinkButton({ kind, url, onOpen }: { kind: "doi" | "arxiv" | "web"; url: string; onOpen: (url: string) => void }) {
  const { t } = useLingui();
  const label = kind === "doi" ? "DOI" : kind === "arxiv" ? "arXiv" : t`Link`;
  return (
    <Button size="compact" variant="ghost" title={url} onClick={() => onOpen(url)}>
      <ExternalLink size={13} aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * One field: its name and its value between the delimiters it was written
 * with. The value is written back when the field loses focus (or on Enter,
 * ⌘Enter in a long field); Escape puts the written value back.
 */
function FieldRow(props: {
  field: BibField;
  raw: string;
  macros: Map<string, string>;
  editable: boolean;
  onCommit: (raw: string) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const { field } = props;
  const { text, style } = editableValue(props.raw);
  const id = useId();
  const [invalid, setInvalid] = useState(false);
  // A long value's box grows with its text, and again when the pane's width rewraps it.
  const observerRef = useRef<ResizeObserver | null>(null);
  const fitToContent = useCallback((element: HTMLTextAreaElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element) return;
    resizeTextareaToContent(element);
    let width = element.clientWidth;
    observerRef.current = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resizeTextareaToContent(element);
    });
    observerRef.current.observe(element);
  }, []);
  const long = LONG_FIELDS.has(field.name.toLowerCase()) || text.length > 48 || text.includes("\n");
  const save = (value: string) => {
    if (value === text) return setInvalid(false);
    const raw = encodeValue(value, style, props.macros);
    setInvalid(raw === null);
    if (raw !== null) props.onCommit(raw);
  };
  const name = field.name;
  const common = {
    id,
    defaultValue: text,
    readOnly: !props.editable,
    spellCheck: false,
    "aria-invalid": invalid || undefined,
    onBlur: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => save(event.currentTarget.value),
  };
  const revert = (target: HTMLInputElement | HTMLTextAreaElement) => {
    target.value = text;
    setInvalid(false);
    leaveField(target);
  };
  return (
    <div className="bib-field" data-style={style}>
      <label htmlFor={id} className="bib-field-name">{name}</label>
      {long ? (
        <Textarea
          {...common}
          rows={1}
          className="bib-field-value"
          ref={fitToContent}
          onInput={(event) => resizeTextareaToContent(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) leaveField(event.currentTarget);
            if (event.key === "Escape") revert(event.currentTarget);
          }}
        />
      ) : (
        <Input
          {...common}
          controlSize="compact"
          className="bib-field-value"
          onKeyDown={(event) => {
            if (event.key === "Enter") leaveField(event.currentTarget);
            if (event.key === "Escape") revert(event.currentTarget);
          }}
        />
      )}
      {props.editable && (
        <IconButton size="compact" className="bib-field-remove" label={t`Remove the ${name} field`} onClick={props.onRemove}>
          <X size={13} aria-hidden="true" />
        </IconButton>
      )}
      {invalid && (
        <InlineMessage level="error" className="bib-field-error">
          {style === "raw" ? t`This value joins strings with #; keep it valid BibTeX.` : t`Braces in the value must be balanced.`}
        </InlineMessage>
      )}
    </div>
  );
}
