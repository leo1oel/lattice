import { Link2, Pencil } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { CloseButton } from "../components/ui/icon-button";
import { EmptyState } from "../components/ui/empty-state";

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
  const { t } = useLingui();
  const definitions = props.occurrences.filter((item) => item.role === "definition").length;
  const references = props.occurrences.length - definitions;
  const definitionSummary = definitions === 1 ? t`${definitions} definition` : t`${definitions} definitions`;
  const referenceSummary = references === 1 ? t`${references} reference` : t`${references} references`;
  const summary = definitions && references
    ? t`${definitionSummary} · ${referenceSummary}`
    : definitions
      ? definitionSummary
      : references
        ? referenceSummary
        : t`No occurrences`;
  const symbol = props.symbol;
  const roleLabel = (role: string) =>
    role === "definition" ? t`definition` : role === "reference" ? t`reference` : role;

  return (
    <section className="references-panel" aria-label={t`Symbol references`}>
      <div className="references-panel-bar">
        <div className="references-panel-title">
          <Link2 size={13} />
          <span>
            {props.kind === "label"
              ? <Trans>Label <code>{symbol}</code></Trans>
              : <Trans>Citation <code>{symbol}</code></Trans>}
          </span>
          <small>{summary}</small>
        </div>
        <button type="button" title={t`Rename symbol`} onClick={props.onRename}>
          <Pencil size={13} />
          <span><Trans>Rename</Trans></span>
        </button>
        <CloseButton
          label={t`Dismiss references`}
          size="compact"
          onClick={props.onDismiss}
        />
      </div>
      {props.occurrences.length ? (
        <ul className="references-panel-list">
          {props.occurrences.map((occurrence, index) => {
            const location = `${occurrence.path}:${occurrence.line}`;
            return (
            <li key={`${occurrence.path}:${occurrence.line}:${occurrence.role}:${index}`}>
              <button
                type="button"
                className="references-panel-item"
                onClick={() => props.onSelect(occurrence)}
                title={t`Go to ${location}`}
              >
                <span className={`references-role ${occurrence.role}`}>{roleLabel(occurrence.role)}</span>
                <span className="references-location">{occurrence.path}:{occurrence.line}</span>
                <span className="references-snippet">{occurrence.snippet}</span>
              </button>
            </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          align="start"
          density="compact"
          description={t`No occurrences found`}
        />
      )}
    </section>
  );
}
