import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { EmptyState } from "./empty-state";
import { ModalDialog } from "./modal-dialog";
import { SearchField } from "./search-field";
import { FluidHoverSurface } from "./fluid-hover-surface";
import { ScrollArea } from "./scroll-area";
import { rankMatches, scoreItem } from "./picker-ranking";
import { searchPickerRow } from "./picker-row";

export type SearchPickerItem = {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  /** Drawn before the label; every row of a list that has any should have one, so labels line up. */
  icon?: ReactNode;
  /** The keys that run it without the picker, one keycap each ("⌘", "⇧", "K"), drawn at the row's end. */
  keys?: readonly string[];
  /** Words a search should find it by that the row does not show (a setting's options, a paper's authors). */
  keywords?: string;
};

/** What a query that found nothing says, and the one row that may still answer it. */
export type PickerNoMatch<T> = {
  /** What was not found, naming the query. */
  title: string;
  description?: string;
  /** Listed alone, so Enter runs it: the search the picker could not make (the palette's Find in project). */
  fallback?: T;
};

/** Gather ranked results by section, keeping each section where its best match ranked. */
function sectionResults<T>(ranked: T[], groupOf?: (item: T) => string | undefined) {
  if (!groupOf) return { results: ranked, sectioned: false };
  const sections = new Map<string | undefined, T[]>();
  for (const item of ranked) {
    const group = groupOf(item);
    const section = sections.get(group);
    if (section) section.push(item);
    else sections.set(group, [item]);
  }
  return { results: [...sections.values()].flat(), sectioned: sections.size > 1 };
}

/**
 * The keyboard-driven modal list behind quick open and the command pickers:
 * a search field that owns Up/Down/Enter over a ranked, hover-highlighted
 * list. Mount it only while open, so each opening starts from an empty query.
 * It has no close button: Escape and a click outside dismiss it, as in every
 * command bar.
 */
export function PickerDialog<T>(props: {
  label: string;
  searchLabel: string;
  placeholder: string;
  /** Where an item's detail goes: under its label, or trailing it on one line. */
  detailPlacement?: "below" | "end";
  emptyText: string;
  /** Replaces `emptyText` when a typed query found nothing. */
  noMatch?: (query: string) => PickerNoMatch<T> | null;
  rank: (query: string) => T[];
  itemKey: (item: T) => string;
  /** Draws a row; `query` is the trimmed text it was ranked against, for marking the match. */
  renderItem: (item: T, query: string) => ReactNode;
  /** The accessible name, when the rendered item is more than its text. */
  itemLabel?: (item: T) => string | undefined;
  /**
   * The section an item belongs to. With more than one section among the
   * results, they gather under one heading each instead of repeating it on
   * every row, in the order their best match ranks.
   */
  groupOf?: (item: T) => string | undefined;
  /** A strip under the list (the palette's keyboard hints). */
  footer?: ReactNode;
  /** Added to the dialog's own class, for a picker that sizes itself differently. */
  className?: string;
  onClose: () => void;
  onSelect: (item: T) => void;
  /** The highlighted item, whenever it changes (for prefetching). */
  onIntent?: (item: T) => void;
}) {
  const { rank, onIntent, groupOf, noMatch: describeNoMatch } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trimmed = query.trim();
  const { results, sectioned, noMatch } = useMemo(() => {
    const found = sectionResults(rank(trimmed), groupOf);
    const missing = !found.results.length && trimmed ? describeNoMatch?.(trimmed) ?? null : null;
    return missing?.fallback ? { results: [missing.fallback], sectioned: false, noMatch: missing } : { ...found, noMatch: missing };
  }, [rank, trimmed, groupOf, describeNoMatch]);
  const lastIndex = Math.max(0, results.length - 1);
  const selected = results[Math.min(lastIndex, Math.max(0, active))] ?? null;
  useEffect(() => {
    if (selected !== null) onIntent?.(selected);
  }, [onIntent, selected]);
  const listRef = useRef<HTMLDivElement>(null);
  const search = (value: string) => {
    setQuery(value);
    setActive(0);
    // New results start from the top, where their best match is.
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  // Only the keyboard moves the highlight out of sight, so only it scrolls
  // the list after it; a row the pointer is on is already in view.
  const keyedRef = useRef(false);
  useEffect(() => {
    if (!keyedRef.current) return;
    keyedRef.current = false;
    listRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, results]);
  // A list scrolled under a resting pointer moves rows beneath it, and the
  // browser reports that as the pointer moving. Only a pointer that really
  // moved takes the highlight from the keyboard.
  const pointerRef = useRef({ x: Number.NaN, y: Number.NaN });
  const step = (by: 1 | -1) => {
    keyedRef.current = true;
    setActive((value) => Math.min(Math.max(0, Math.min(value, lastIndex) + by), lastIndex));
  };

  return (
    <ModalDialog label={props.label} onClose={props.onClose}>
      <div className={props.className ? `modal quick-open-modal ${props.className}` : "modal quick-open-modal"} data-detail={props.detailPlacement ?? "below"}>
        <div className="quick-open-header">
          <SearchField
            autoFocus
            aria-label={props.searchLabel}
            placeholder={props.placeholder}
            value={query}
            onChange={(event) => search(event.target.value)}
            onClear={() => search("")}
            onKeyDown={(event) => {
              // ⌃N and ⌃P step too, as in every macOS text list.
              const down = event.key === "ArrowDown" || (event.ctrlKey && !event.metaKey && event.key === "n");
              const up = event.key === "ArrowUp" || (event.ctrlKey && !event.metaKey && event.key === "p");
              if (down || up) {
                event.preventDefault();
                step(down ? 1 : -1);
              }
              if (event.key === "Enter" && selected !== null) {
                event.preventDefault();
                props.onSelect(selected);
              }
            }}
          />
        </div>
        {noMatch && (
          <div className="picker-no-match" role="status">
            <strong>{noMatch.title}</strong>
            {noMatch.description && <span>{noMatch.description}</span>}
          </div>
        )}
        {/* The app's own scrollbar, not the native one: WebKit only repaints a
            native thumb's :hover colour when something else repaints the list,
            so a list longer than the dialog looked like it ended at the fold. */}
        <ScrollArea
          className="quick-open-scroll"
          hidden={Boolean(noMatch && !results.length)}
          viewportRef={listRef}
          viewportProps={{ role: "listbox", tabIndex: -1 }}
          contentClassName="quick-open-list fluid-hover-surface"
        >
          <FluidHoverSurface follow='[aria-selected="true"]' />
          {results.map((item, index) => {
            const group = sectioned ? groupOf?.(item) : undefined;
            return (
              <Fragment key={props.itemKey(item)}>
                {group && (index === 0 || group !== groupOf?.(results[index - 1])) && (
                  <div className="picker-section" data-slot="picker-section-label" aria-hidden="true">{group}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-label={props.itemLabel?.(item)}
                  aria-selected={index === active}
                  className={index === active ? "active" : ""}
                  onMouseMove={(event) => {
                    const last = pointerRef.current;
                    if (event.clientX === last.x && event.clientY === last.y) return;
                    pointerRef.current = { x: event.clientX, y: event.clientY };
                    if (index !== active) setActive(index);
                  }}
                  onClick={() => props.onSelect(item)}
                >
                  {props.renderItem(item, trimmed)}
                </button>
              </Fragment>
            );
          })}
          {!results.length && !noMatch && <EmptyState density="compact" description={props.emptyText} />}
        </ScrollArea>
        {props.footer}
      </div>
    </ModalDialog>
  );
}

type SearchPickerProps = {
  title: string;
  placeholder: string;
  detailPlacement?: "below" | "end";
  items: SearchPickerItem[];
  /**
   * What an empty query lists first, in this order and under their own
   * groups (recent commands, the ones for the open document). Each also in
   * `items` is listed only here; a typed query ranks `items` alone, so these
   * never displace a match.
   */
  leading?: SearchPickerItem[];
  onClose: () => void;
  onSelect: (item: SearchPickerItem) => void;
};

export function SearchPickerDialog({ open, ...props }: SearchPickerProps & { open: boolean }) {
  // Re-keyed so another picker starts from an empty query. Items that arrive
  // while it is open (Go to symbol reads the included files) only re-rank, so
  // what the writer already typed stays.
  return open ? <SearchPickerDialogForm key={props.title} {...props} /> : null;
}

function SearchPickerDialogForm({ title, items, leading, ...props }: SearchPickerProps) {
  const { t } = useLingui();
  const rank = useMemo(() => (query: string) => {
    const lead = query ? [] : leading ?? [];
    const leadIds = new Set(lead.map((item) => item.id));
    return [...lead, ...rankMatches(
      leadIds.size ? items.filter((item) => !leadIds.has(item.id)) : items,
      (item) => scoreItem(item, query),
      (left, right) => (left.group ?? "").localeCompare(right.group ?? "") || left.label.localeCompare(right.label),
      60,
    )];
  }, [items, leading]);
  return (
    <PickerDialog
      {...props}
      label={title}
      searchLabel={title}
      emptyText={t`No matches`}
      rank={rank}
      itemKey={(item) => item.id}
      groupOf={(item) => item.group}
      renderItem={searchPickerRow}
    />
  );
}
