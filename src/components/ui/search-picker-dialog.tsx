import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { CloseButton } from "./icon-button";
import { EmptyState } from "./empty-state";
import { ModalDialog } from "./modal-dialog";
import { SearchField } from "./search-field";
import { FluidHoverSurface } from "./fluid-hover-surface";
import { rankMatches, subsequenceScore } from "./picker-ranking";

export type SearchPickerItem = {
  id: string;
  label: string;
  detail?: string;
  group?: string;
};

function scoreItem(item: SearchPickerItem, query: string): number {
  const needle = query.toLocaleLowerCase();
  if (!needle) return 1;
  const hay = `${item.label} ${item.detail ?? ""} ${item.group ?? ""}`.toLocaleLowerCase();
  if (item.label.toLocaleLowerCase() === needle) return 1000;
  if (hay.startsWith(needle)) return 900;
  if (hay.includes(needle)) return 500 - hay.indexOf(needle);
  return subsequenceScore(hay, needle);
}

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
 */
export function PickerDialog<T>(props: {
  label: string;
  searchLabel: string;
  placeholder: string;
  closeLabel: string;
  compactClose?: boolean;
  /** Where an item's detail goes: under its label, or trailing it on one line. */
  detailPlacement?: "below" | "end";
  emptyText: string;
  rank: (query: string) => T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** The accessible name, when the rendered item is more than its text. */
  itemLabel?: (item: T) => string;
  /**
   * The section an item belongs to. With more than one section among the
   * results, they gather under one heading each instead of repeating it on
   * every row, in the order their best match ranks.
   */
  groupOf?: (item: T) => string | undefined;
  onClose: () => void;
  onSelect: (item: T) => void;
  /** The highlighted item, whenever it changes (for prefetching). */
  onIntent?: (item: T) => void;
}) {
  const { rank, onIntent, groupOf } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { results, sectioned } = useMemo(() => sectionResults(rank(query.trim()), groupOf), [rank, query, groupOf]);
  const lastIndex = Math.max(0, results.length - 1);
  const selected = results[Math.min(lastIndex, Math.max(0, active))] ?? null;
  useEffect(() => {
    if (selected !== null) onIntent?.(selected);
  }, [onIntent, selected]);
  const search = (value: string) => {
    setQuery(value);
    setActive(0);
  };

  return (
    <ModalDialog label={props.label} onClose={props.onClose}>
      <div className="modal quick-open-modal" data-detail={props.detailPlacement ?? "below"}>
        <div className="quick-open-header">
          <SearchField
            autoFocus
            aria-label={props.searchLabel}
            placeholder={props.placeholder}
            value={query}
            onChange={(event) => search(event.target.value)}
            onClear={() => search("")}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, lastIndex));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter" && selected !== null) {
                event.preventDefault();
                props.onSelect(selected);
              }
            }}
            trailing={props.compactClose
              ? <CloseButton label={props.closeLabel} size="compact" data-hit-area onClick={props.onClose} />
              : <CloseButton label={props.closeLabel} onClick={props.onClose} />}
          />
        </div>
        <div className="quick-open-list fluid-hover-surface" role="listbox">
          <FluidHoverSurface />
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
                  onMouseEnter={() => setActive(index)}
                  onClick={() => props.onSelect(item)}
                >
                  {props.renderItem(item)}
                </button>
              </Fragment>
            );
          })}
          {!results.length && <EmptyState density="compact" description={props.emptyText} />}
        </div>
      </div>
    </ModalDialog>
  );
}

type SearchPickerProps = {
  title: string;
  placeholder: string;
  detailPlacement?: "below" | "end";
  items: SearchPickerItem[];
  onClose: () => void;
  onSelect: (item: SearchPickerItem) => void;
};

export function SearchPickerDialog({ open, ...props }: SearchPickerProps & { open: boolean }) {
  // Re-keyed so another picker starts from an empty query. Items that arrive
  // while it is open (Go to symbol reads the included files) only re-rank, so
  // what the writer already typed stays.
  return open ? <SearchPickerDialogForm key={props.title} {...props} /> : null;
}

function SearchPickerDialogForm({ title, items, ...props }: SearchPickerProps) {
  const { t } = useLingui();
  const rank = useMemo(() => (query: string) => rankMatches(
    items,
    (item) => scoreItem(item, query),
    (left, right) => (left.group ?? "").localeCompare(right.group ?? "") || left.label.localeCompare(right.label),
    60,
  ), [items]);
  return (
    <PickerDialog
      {...props}
      label={title}
      searchLabel={title}
      closeLabel={t`Close ${title}`}
      emptyText={t`No matches`}
      rank={rank}
      itemKey={(item) => item.id}
      groupOf={(item) => item.group}
      renderItem={(item) => <>
        <span className="picker-label">{item.label}</span>
        {item.detail && <em className="picker-detail">{item.detail}</em>}
      </>}
    />
  );
}
