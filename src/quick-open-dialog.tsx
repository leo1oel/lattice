import { useEffect, useMemo, useState } from "react";
import { CloseButton } from "./components/ui/icon-button";
import { EmptyState } from "./components/ui/empty-state";
import { ModalDialog } from "./components/ui/modal-dialog";
import { SearchField } from "./components/ui/search-field";

function scorePath(path: string, query: string): number {
  const hay = path.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  if (!needle) return 1;
  if (hay === needle) return 1000;
  if (hay.endsWith(`/${needle}`)) return 900;
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

export function QuickOpenDialog(props: {
  open: boolean;
  paths: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
  onIntent?: (path: string) => void;
}) {
  if (!props.open) return null;
  return (
    <QuickOpenDialogForm
      key="quick-open"
      paths={props.paths}
      onClose={props.onClose}
      onOpen={props.onOpen}
      onIntent={props.onIntent}
    />
  );
}

function QuickOpenDialogForm(props: {
  paths: string[];
  onClose: () => void;
  onOpen: (path: string) => void;
  onIntent?: (path: string) => void;
}) {
  const { onIntent } = props;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const ranked = props.paths
      .map((path) => ({ path, score: scorePath(path, query.trim()) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return ranked.slice(0, 40).map((item) => item.path);
  }, [props.paths, query]);
  const selected = results[clamp(active, 0, Math.max(0, results.length - 1))] ?? null;
  useEffect(() => {
    if (selected) onIntent?.(selected);
  }, [onIntent, selected]);

  return (
    <ModalDialog label="Quick open file" onClose={props.onClose}>
      <div
        className="modal quick-open-modal"
      >
        <div className="quick-open-header">
          <SearchField
            autoFocus
            aria-label="Quick open search"
            placeholder="Open file…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onClear={() => {
              setQuery("");
              setActive(0);
            }}
            onKeyDown={(event) => {
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
                props.onOpen(selected);
              }
            }}
            trailing={
              <CloseButton
                label="Close quick search"
                size="compact"
                data-hit-area
                onClick={props.onClose}
              />
            }
          />
        </div>
        <div className="quick-open-list" role="listbox">
          {results.map((path, index) => (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseEnter={() => setActive(index)}
              onClick={() => props.onOpen(path)}
            >
              {path}
            </button>
          ))}
          {!results.length && (
            <EmptyState density="compact" description="No matching files." />
          )}
        </div>
      </div>
    </ModalDialog>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
