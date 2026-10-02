import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Replace } from "lucide-react";
import { Button } from "../components/ui/button";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { SheetDialog } from "../components/ui/sheet-dialog";

type ReplacePreviewMatch = {
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
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(true);
  const [useRegex, setUseRegex] = useState(false);
  // What the shown preview was asked for. Editing the query or an option
  // after previewing must not leave "Replace N" armed: it would replace the
  // new query's matches, which nobody has seen.
  const [previewedFor, setPreviewedFor] = useState<string | null>(null);

  if (!props.open) return null;

  const options: ReplaceOptions = { matchCase, useRegex };
  const searchKey = JSON.stringify([query, matchCase, useRegex]);
  const preview = previewedFor === searchKey ? props.preview : null;
  const runPreview = () => {
    setPreviewedFor(searchKey);
    props.onPreview(query, options);
  };
  const canReplace = Boolean(query.trim() && preview && preview.replacements > 0 && !props.busy);
  const replacementCount = preview?.replacements ?? 0;
  const fileCount = preview?.files ?? 0;
  const matchSummary = replacementCount === 1 ? t`${replacementCount} match` : t`${replacementCount} matches`;
  const fileSummary = fileCount === 1 ? t`${fileCount} file` : t`${fileCount} files`;
  const previewSummary = preview && preview.matches.length < preview.replacements
    ? t`${matchSummary} in ${fileSummary} (showing first 200)`
    : t`${matchSummary} in ${fileSummary}`;

  return (
    <SheetDialog className="project-replace" label={t`Project find and replace`} dirty={Boolean(query || replacement)} onClose={props.onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<Replace size={16} />}
        title={t`Find & replace in project`}
        onClose={props.onClose}
      />
      <p className="drawer-copy"><Trans>Replacements are recorded in project history</Trans></p>
      <label>
        <Trans>Find</Trans>
        <SearchField
          autoFocus
          aria-label={t`Find text to replace`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          placeholder={useRegex ? t`Regular expression` : t`Text to find`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim() && !props.busy) {
              event.preventDefault();
              runPreview();
            }
          }}
        />
      </label>
      <label>
        <Trans>Replace with</Trans>
        <Input
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
          placeholder={t`Replacement text`}
        />
      </label>
      <div className="project-replace-options">
        {([
          ["match-case", t`Match case`, matchCase, setMatchCase],
          ["regex", t`Regex`, useRegex, setUseRegex],
        ] as const).map(([optionKey, label, checked, setChecked]) => (
          <CheckboxField key={optionKey} checked={checked} label={label} onChange={(event) => setChecked(event.target.checked)} />
        ))}
      </div>
      {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
      {preview && (
        <div className="project-replace-preview" aria-live="polite">
          <div className="project-replace-preview-summary">
            {preview.replacements ? previewSummary : t`No matches found`}
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
        <Button variant="ghost" onClick={props.onClose}><Trans>Cancel</Trans></Button>
        <Button
          disabled={!query.trim() || props.busy}
          onClick={runPreview}
        >
          {props.busy && !preview ? t`Searching…` : t`Preview`}
        </Button>
        <Button
          variant="primary"
          disabled={!canReplace}
          onClick={() => props.onReplace(query, replacement, options)}
        >
          {props.busy && preview ? t`Replacing…` : preview ? t`Replace ${replacementCount}` : t`Replace all`}
        </Button>
      </div>
    </SheetDialog>
  );
}
