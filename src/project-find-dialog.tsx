import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

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
    const timer = window.setTimeout(() => onSearchRef.current(trimmed), 180);
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

  if (!props.open) return null;

  const openActive = () => {
    const hit = fileHits[activeIndex] ?? paperHits[0];
    if (!hit) return;
    if (hit.kind === "file") {
      props.onOpenHit(hit.path, hit.line ?? undefined);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside
        className="project-replace project-find"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Find in project"
      >
        <div className="drawer-header">
          <div><Search size={16} /><span>Find in project</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          Search `.tex`, `.bib`, and other source files with an indexed full-text index. Enter opens the selected hit; F3 / ⇧F3 cycles.
        </p>
        <label>
          Query
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Phrase or tokens"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
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
        <div className="project-replace-preview" aria-live="polite">
          <div className="project-replace-preview-summary">
            {!query.trim()
              ? "Type to search the project."
              : props.busy
                ? "Searching…"
                : `${fileHits.length} hit${fileHits.length === 1 ? "" : "s"}${
                  paperHits.length ? ` · ${paperHits.length} paper${paperHits.length === 1 ? "" : "s"}` : ""
                }`}
          </div>
          {fileHits.length > 0 && (
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
                    <span className="project-replace-hit-path">
                      {hit.path}{hit.line ? `:${hit.line}` : ""}
                    </span>
                    <span className="project-replace-hit-preview">{hit.snippet || hit.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {paperHits.length > 0 && (
            <div className="project-find-papers">
              <div className="project-replace-preview-summary">Papers</div>
              <ul className="project-replace-hits">
                {paperHits.map((hit) => (
                  <li key={`paper:${hit.path}:${hit.title}`}>
                    <div className="project-replace-hit">
                      <span className="project-replace-hit-path">{hit.title}</span>
                      <span className="project-replace-hit-preview">{hit.snippet || hit.path}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="table-generator-actions">
          <button type="button" className="secondary" onClick={props.onClose}>Close</button>
          <button
            type="button"
            disabled={!fileHits.length}
            onClick={openActive}
          >
            Open hit
          </button>
        </div>
      </aside>
    </div>
  );
}
