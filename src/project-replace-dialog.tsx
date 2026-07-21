import { useState } from "react";
import { Replace, X } from "lucide-react";

export type ReplacePreviewMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type ReplacePreviewResult = {
  matches: ReplacePreviewMatch[];
  files: number;
  replacements: number;
};

export type ReplaceOptions = {
  matchCase: boolean;
  useRegex: boolean;
};

export function ProjectReplaceDialog(props: {
  open: boolean;
  busy: boolean;
  error: string | null;
  preview: ReplacePreviewResult | null;
  onClose: () => void;
  onPreview: (query: string, options: ReplaceOptions) => void;
  onReplace: (query: string, replacement: string, options: ReplaceOptions) => void;
  onOpenMatch?: (path: string, line: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(true);
  const [useRegex, setUseRegex] = useState(false);

  if (!props.open) return null;

  const options: ReplaceOptions = { matchCase, useRegex };
  const preview = props.preview;
  const canReplace = Boolean(query.trim() && preview && preview.replacements > 0 && !props.busy);

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="project-replace" onMouseDown={(event) => event.stopPropagation()} aria-label="Project find and replace">
        <div className="drawer-header">
          <div><Replace size={16} /><span>Find & replace in project</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">Preview matches across `.tex`, `.bib`, and other project source files, then confirm replace. Changes are recorded in project history.</p>
        <label>
          Find
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={useRegex ? "Regular expression" : "Text to find"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim() && !props.busy) {
                event.preventDefault();
                props.onPreview(query, options);
              }
            }}
          />
        </label>
        <label>
          Replace with
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="Replacement text"
          />
        </label>
        <div className="project-replace-options">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => setMatchCase(event.target.checked)}
            />
            <span>Match case</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={useRegex}
              onChange={(event) => setUseRegex(event.target.checked)}
            />
            <span>Regex</span>
          </label>
        </div>
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        {preview && (
          <div className="project-replace-preview" aria-live="polite">
            <div className="project-replace-preview-summary">
              {preview.replacements
                ? `${preview.replacements} match${preview.replacements === 1 ? "" : "es"} in ${preview.files} file${preview.files === 1 ? "" : "s"}${preview.matches.length < preview.replacements ? " (showing first 200)" : ""}`
                : "No matches found."}
            </div>
            {preview.matches.length > 0 && (
              <ul className="project-replace-hits">
                {preview.matches.map((match) => (
                  <li key={`${match.path}:${match.line}:${match.column}:${match.preview}`}>
                    <button
                      type="button"
                      className="project-replace-hit"
                      onClick={() => props.onOpenMatch?.(match.path, match.line)}
                    >
                      <span className="project-replace-hit-path">{match.path}:{match.line}</span>
                      <span className="project-replace-hit-preview">{match.preview}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="table-generator-actions">
          <button type="button" className="secondary" onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            className="secondary"
            disabled={!query.trim() || props.busy}
            onClick={() => props.onPreview(query, options)}
          >
            {props.busy && !preview ? "Searching…" : "Preview"}
          </button>
          <button
            type="button"
            disabled={!canReplace}
            onClick={() => props.onReplace(query, replacement, options)}
          >
            {props.busy && preview ? "Replacing…" : preview ? `Replace ${preview.replacements}` : "Replace all"}
          </button>
        </div>
      </aside>
    </div>
  );
}
