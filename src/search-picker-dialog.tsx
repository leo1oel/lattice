import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

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
  let score = 0;
  let index = 0;
  for (const character of needle) {
    const next = hay.indexOf(character, index);
    if (next < 0) return 0;
    score += 10 - Math.min(9, next - index);
    index = next + 1;
  }
  return score;
}

export function SearchPickerDialog(props: {
  open: boolean;
  title: string;
  placeholder: string;
  items: SearchPickerItem[];
  onClose: () => void;
  onSelect: (item: SearchPickerItem) => void;
}) {
  if (!props.open) return null;
  return (
    <SearchPickerDialogForm
      key={`${props.title}-${props.items.length}`}
      title={props.title}
      placeholder={props.placeholder}
      items={props.items}
      onClose={props.onClose}
      onSelect={props.onSelect}
    />
  );
}

function SearchPickerDialogForm(props: {
  title: string;
  placeholder: string;
  items: SearchPickerItem[];
  onClose: () => void;
  onSelect: (item: SearchPickerItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const ranked = props.items
      .map((item) => ({ item, score: scoreItem(item, query.trim()) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || (left.item.group ?? "").localeCompare(right.item.group ?? "")
        || left.item.label.localeCompare(right.item.label));
    return ranked.slice(0, 60).map((entry) => entry.item);
  }, [props.items, query]);
  const selected = results[clamp(active, 0, Math.max(0, results.length - 1))] ?? null;

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="modal quick-open-modal"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label={props.title}
      >
        <div className="quick-open-header">
          <Search size={15} />
          <input
            autoFocus
            aria-label={props.title}
            placeholder={props.placeholder}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") props.onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, Math.max(0, results.length - 1)));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter" && selected) {
                event.preventDefault();
                props.onSelect(selected);
              }
            }}
          />
          <button type="button" onClick={props.onClose}><X size={15} /></button>
        </div>
        <div className="quick-open-list" role="listbox">
          {results.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => props.onSelect(item)}
            >
              <span className="picker-label">
                {item.group && <small className="picker-group">{item.group}</small>}
                {item.label}
              </span>
              {item.detail && <em className="picker-detail">{item.detail}</em>}
            </button>
          ))}
          {!results.length && <p className="quick-open-empty">No matches.</p>}
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
