import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  emptyText: string;
  rank: (query: string) => T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onClose: () => void;
  onSelect: (item: T) => void;
  /** The highlighted item, whenever it changes (for prefetching). */
  onIntent?: (item: T) => void;
}) {
  const { rank, onIntent } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => rank(query.trim()), [rank, query]);
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
      <div className="modal quick-open-modal">
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
          {results.map((item, index) => (
            <button
              key={props.itemKey(item)}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => props.onSelect(item)}
            >
              {props.renderItem(item)}
            </button>
          ))}
          {!results.length && <EmptyState density="compact" description={props.emptyText} />}
        </div>
      </div>
    </ModalDialog>
  );
}

type SearchPickerProps = {
  title: string;
  placeholder: string;
  items: SearchPickerItem[];
  onClose: () => void;
  onSelect: (item: SearchPickerItem) => void;
};

export function SearchPickerDialog({ open, ...props }: SearchPickerProps & { open: boolean }) {
  // Re-keyed so a new title or item set starts from an empty query.
  return open ? <SearchPickerDialogForm key={`${props.title}-${props.items.length}`} {...props} /> : null;
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
      renderItem={(item) => <>
        <span className="picker-label">
          {item.group && <small className="picker-group">{item.group}</small>}
          {item.label}
        </span>
        {item.detail && <em className="picker-detail">{item.detail}</em>}
      </>}
    />
  );
}
