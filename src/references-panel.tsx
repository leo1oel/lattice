import { Link2, Pencil, X } from "lucide-react";

export type SymbolOccurrence = {
  kind: "label" | "citation" | string;
  symbol: string;
  role: "definition" | "reference" | string;
  path: string;
  line: number;
  snippet: string;
};

export function ReferencesPanel(props: {
  symbol: string;
  kind: "label" | "citation";
  occurrences: SymbolOccurrence[];
  onSelect: (occurrence: SymbolOccurrence) => void;
  onRename: () => void;
  onDismiss: () => void;
}) {
  const definitions = props.occurrences.filter((item) => item.role === "definition").length;
  const references = props.occurrences.length - definitions;
  const summary = [
    definitions ? `${definitions} definition${definitions === 1 ? "" : "s"}` : "",
    references ? `${references} reference${references === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ") || "No occurrences";

  return (
    <section className="references-panel" aria-label="Symbol references">
      <div className="references-panel-bar">
        <div className="references-panel-title">
          <Link2 size={13} />
          <span>
            {props.kind === "label" ? "Label" : "Citation"}
            {" "}
            <code>{props.symbol}</code>
          </span>
          <small>{summary}</small>
        </div>
        <button type="button" title="Rename symbol" onClick={props.onRename}>
          <Pencil size={13} />
          <span>Rename</span>
        </button>
        <button type="button" title="Dismiss references" onClick={props.onDismiss}>
          <X size={13} />
        </button>
      </div>
      {props.occurrences.length ? (
        <ul className="references-panel-list">
          {props.occurrences.map((occurrence, index) => (
            <li key={`${occurrence.path}:${occurrence.line}:${occurrence.role}:${index}`}>
              <button
                type="button"
                className="references-panel-item"
                onClick={() => props.onSelect(occurrence)}
                title={`Go to ${occurrence.path}:${occurrence.line}`}
              >
                <span className={`references-role ${occurrence.role}`}>{occurrence.role}</span>
                <span className="references-location">{occurrence.path}:{occurrence.line}</span>
                <span className="references-snippet">{occurrence.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="references-panel-empty">No occurrences found.</p>
      )}
    </section>
  );
}
