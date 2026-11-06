/**
 * The reference in front in a .bib file's visual form (bib-visual-editor.tsx):
 * its type, key, links and where the manuscript cites it, and a form whose
 * every field edits the file in place through the list's `edit`, which finds
 * the entry again in the file as it is now.
 */
import { useCallback, useId, useReducer, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, BookOpen, Code2, ExternalLink, Trash2, X } from "lucide-react";
import { CopyButton } from "../components/copy-button";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { resizeTextareaToContent } from "../components/ui/auto-resize-textarea";
import type { SymbolOccurrence } from "../project/references-panel";
import {
  addFieldEdit, changeTypeEdit, editableValue, encodeValue, removeFieldEdit, renameKeyEdit, replaceValueEdit, validCitationKey,
  type BibEdit, type BibEntry, type BibField, type BibSummary,
} from "./bib-document";
import type { BibVisualEditorProps } from "./bib-visual-editor";
import { sameIgnoringCase as sameKey } from "../lib/equality";

/** The types the type menu offers; an entry of another type keeps it and lists it too. */
const ENTRY_TYPES = [
  "article", "inproceedings", "book", "incollection", "inbook", "proceedings", "phdthesis", "mastersthesis",
  "techreport", "misc", "online", "unpublished", "manual", "booklet",
];

/** Fields whose values run long enough for a box that wraps. */
const LONG_FIELDS = new Set(["title", "author", "editor", "abstract", "note", "annote", "annotation", "keywords", "booktitle", "journal"]);

export type Row = { entry: BibEntry; summary: BibSummary; index: number };
/** A change to one entry, measured on `source` with `entry` as found there; falsy makes none. */
export type EntryEdit = (source: string, entry: BibEntry) => BibEdit | null | false | undefined;
export type Committed = { next: string; base: string; change: BibEdit };

/** Leave a field (which writes it) for the editor around it, so its keys (⌘Z) still apply. */
const leaveField = (field: HTMLElement) => field.closest<HTMLElement>(".bib-visual")?.focus();

/** `entry` still has `field` (by name) at `index`. */
const sameField = (entry: BibEntry, index: number, field: BibField) => entry.fields[index]?.name === field.name;

/** What the detail's own controls hold: the key's error, and the field being added. */
type DetailState = { keyError: string | null; newField: { name: string; value: string; error: string | null } };
type DetailAction =
  | { type: "key-checked"; error: string | null }
  | { type: "new-field-typed"; name?: string; value?: string }
  | { type: "new-field-refused"; error: string }
  | { type: "new-field-added" };
const NO_NEW_FIELD = { name: "", value: "", error: null };

function reduceDetail(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case "key-checked": return { ...state, keyError: action.error };
    case "new-field-typed": return { ...state, newField: { name: action.name ?? state.newField.name, value: action.value ?? state.newField.value, error: null } };
    case "new-field-refused": return { ...state, newField: { ...state.newField, error: action.error } };
    case "new-field-added": return { ...state, newField: NO_NEW_FIELD };
  }
}

export function EntryDetail(props: BibVisualEditorProps & {
  /** The text `row` was read from, which its offsets measure. */
  parsedText: string;
  row: Row;
  rows: Row[];
  macros: Map<string, string>;
  usages: { list: SymbolOccurrence[]; everything: boolean } | null;
  edit: (change: EntryEdit) => Committed | null;
  onRenamed: (key: string) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const { row, edit, editable } = props;
  const text = props.parsedText;
  const { entry, summary } = row;
  const paper = props.papers.find((item) => sameKey(item.citationKey, entry.key))
    ?? (summary.arxivId ? props.papers.find((item) => item.arxivId === summary.arxivId) : undefined);
  const readablePaper = paper && (paper.hasFullText || paper.hasBlog) ? paper : undefined;
  const doiUrl = summary.doi && /^10\.\d{4,9}\/\S+$/.test(summary.doi) ? `https://doi.org/${summary.doi}` : null;
  const arxivUrl = summary.arxivId ? `https://arxiv.org/abs/${summary.arxivId}` : null;
  const webUrl = /^https?:\/\//i.test(summary.url) && ![arxivUrl, doiUrl].includes(summary.url) ? summary.url : null;
  const keyId = useId();

  const [{ keyError, newField }, dispatch] = useReducer(reduceDetail, { keyError: null, newField: NO_NEW_FIELD });
  const setKeyError = (error: string | null) => dispatch({ type: "key-checked", error });
  const renameKey = (next: string) => {
    const key = next.trim();
    if (key === entry.key) return setKeyError(null);
    if (!validCitationKey(key)) return setKeyError(t`A citation key cannot be empty or contain spaces, commas, braces, quotes or %.`);
    if (props.rows.some((other) => other !== row && sameKey(other.entry.key, key))) return setKeyError(t`Another reference already uses “${key}”.`);
    setKeyError(null);
    if (edit((_, current) => renameKeyEdit(current, key)) !== null) props.onRenamed(key);
  };
  const types = ENTRY_TYPES.includes(entry.kind) ? ENTRY_TYPES : [entry.kind, ...ENTRY_TYPES];

  const addField = () => {
    const name = newField.name.trim();
    if (!/^[A-Za-z][\w:.+-]*$/.test(name)) return dispatch({ type: "new-field-refused", error: t`Field names start with a letter and have no spaces.` });
    if (entry.fields.some((field) => field.name.toLowerCase() === name.toLowerCase())) {
      return dispatch({ type: "new-field-refused", error: t`This reference already has a “${name}” field.` });
    }
    const raw = encodeValue(newField.value, "brace", props.macros);
    if (raw === null) return dispatch({ type: "new-field-refused", error: t`Braces in the value must be balanced.` });
    if (edit((source, current) => addFieldEdit(source, current, name, raw)) !== null) dispatch({ type: "new-field-added" });
  };

  const nociteAll = "\\nocite{*}";
  const usageLabel = props.usages === null ? null
    : props.usages.list.length ? null
      : props.usages.everything ? t`Not cited by key, but ${nociteAll} includes every entry` : t`Not cited in any .tex file`;

  return (
    <ScrollArea className="bib-detail" viewportClassName="bib-detail-viewport">
      <div className="bib-detail-content">
        <button type="button" className="bib-detail-back" onClick={props.onBack}>
          <ArrowLeft size={13} aria-hidden="true" />
          {t`All references`}
        </button>
        <header className="bib-detail-header">
          <div className="bib-detail-identity">
            <Select value={entry.kind} disabled={!editable} onValueChange={(value) => edit((_, current) => changeTypeEdit(current, value))}>
              <SelectTrigger size="compact" aria-label={t`Entry type`} className="bib-detail-type"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                {types.map((value) => <SelectItem key={value} value={value}>{`@${value}`}</SelectItem>)}
              </SelectContent>
            </Select>
            <label className="sr-only" htmlFor={keyId}>{t`Citation key`}</label>
            <Input
              key={entry.key}
              id={keyId}
              controlSize="compact"
              className="bib-detail-key"
              defaultValue={entry.key}
              readOnly={!editable}
              aria-invalid={keyError ? true : undefined}
              spellCheck={false}
              onBlur={(event) => renameKey(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") leaveField(event.currentTarget);
                if (event.key === "Escape") {
                  event.currentTarget.value = entry.key;
                  setKeyError(null);
                  leaveField(event.currentTarget);
                }
              }}
            />
            <CopyButton className="bib-detail-copy" text={entry.key} title={t`Copy citation key`} />
          </div>
          {keyError && <InlineMessage level="error" className="bib-detail-error">{keyError}</InlineMessage>}
          <h2 className="bib-detail-title">{summary.title || t`Untitled`}</h2>
          {summary.authors && <p className="bib-detail-authors">{summary.authors}</p>}
          {(summary.venue || summary.year) && <p className="bib-detail-venue">{[summary.venue, summary.year].filter(Boolean).join(", ")}</p>}
          <div className="bib-detail-actions">
            {readablePaper && (
              <Button size="compact" variant="secondary" onClick={() => props.onOpenPaper(readablePaper)}>
                <BookOpen size={13} aria-hidden="true" />
                {t`Open paper`}
              </Button>
            )}
            {doiUrl && <LinkButton kind="doi" url={doiUrl} onOpen={props.onOpenUrl} />}
            {arxivUrl && <LinkButton kind="arxiv" url={arxivUrl} onOpen={props.onOpenUrl} />}
            {webUrl && <LinkButton kind="web" url={webUrl} onOpen={props.onOpenUrl} />}
            <Button size="compact" variant="ghost" onClick={() => props.onOpenLine(props.path, entry.line)}>
              <Code2 size={13} aria-hidden="true" />
              {t`Show in source`}
            </Button>
            {editable && (
              <Button size="compact" variant="ghost" className="bib-detail-delete" onClick={props.onDelete}>
                <Trash2 size={13} aria-hidden="true" />
                {t`Delete`}
              </Button>
            )}
          </div>
        </header>
        <section className="bib-detail-section" aria-labelledby={`${keyId}-cited`}>
          <h3 id={`${keyId}-cited`}>{t`Cited in`}</h3>
          {props.usages === null && <p className="bib-detail-muted">{t`Looking through the manuscript…`}</p>}
          {usageLabel && <p className="bib-detail-unused">{usageLabel}</p>}
          {props.usages && props.usages.list.length > 0 && (
            <ul className="bib-detail-usages">
              {props.usages.list.map((usage, index) => (
                <li key={`${usage.path}:${usage.line}:${index}`}>
                  <button type="button" onClick={() => props.onOpenLine(usage.path, usage.line)}>
                    <span className="bib-usage-place">{`${usage.path}:${usage.line}`}</span>
                    <span className="bib-usage-snippet">{usage.snippet.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="bib-detail-section" aria-labelledby={`${keyId}-fields`}>
          <h3 id={`${keyId}-fields`}>{t`Fields`}</h3>
          <div className="bib-detail-fields">
            {entry.fields.map((field, index) => (
              <FieldRow
                key={`${index}:${field.name}:${text.slice(field.valueFrom, field.valueTo)}`}
                field={field}
                raw={text.slice(field.valueFrom, field.valueTo)}
                macros={props.macros}
                editable={editable}
                onCommit={(raw) => edit((_, current) => sameField(current, index, field) && replaceValueEdit(current.fields[index], raw))}
                onRemove={() => edit((source, current) => sameField(current, index, field) && removeFieldEdit(source, current, current.fields[index]))}
              />
            ))}
          </div>
          {editable && (
            <form
              className="bib-detail-add-field"
              onSubmit={(event) => {
                event.preventDefault();
                addField();
              }}
            >
              <Input
                controlSize="compact"
                className="bib-add-field-name"
                value={newField.name}
                placeholder={t`Field`}
                aria-label={t`New field name`}
                spellCheck={false}
                onChange={(event) => dispatch({ type: "new-field-typed", name: event.target.value })}
              />
              <Input
                controlSize="compact"
                value={newField.value}
                placeholder={t`Value`}
                aria-label={t`New field value`}
                onChange={(event) => dispatch({ type: "new-field-typed", value: event.target.value })}
              />
              <Button type="submit" size="compact" variant="secondary" disabled={!newField.name.trim()}>{t`Add field`}</Button>
              {newField.error && <InlineMessage level="error" className="bib-detail-error">{newField.error}</InlineMessage>}
            </form>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

/** An entry's DOI, arXiv abstract or web page, opened in the browser. */
function LinkButton({ kind, url, onOpen }: { kind: "doi" | "arxiv" | "web"; url: string; onOpen: (url: string) => void }) {
  const { t } = useLingui();
  const label = kind === "doi" ? "DOI" : kind === "arxiv" ? "arXiv" : t`Link`;
  return (
    <Button size="compact" variant="ghost" title={url} onClick={() => onOpen(url)}>
      <ExternalLink size={13} aria-hidden="true" />
      {label}
    </Button>
  );
}

/**
 * One field: its name and its value between the delimiters it was written
 * with. The value is written back when the field loses focus (or on Enter,
 * ⌘Enter in a long field); Escape puts the written value back.
 */
function FieldRow(props: {
  field: BibField;
  raw: string;
  macros: Map<string, string>;
  editable: boolean;
  onCommit: (raw: string) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const { field } = props;
  const { text, style } = editableValue(props.raw);
  const id = useId();
  // Whether the value last written was refused: set by each write, cleared by Escape.
  const [invalid, judge] = useReducer((_: boolean, verdict: "refused" | "accepted") => verdict === "refused", false);
  // A long value's box grows with its text, and again when the pane's width rewraps it.
  const observerRef = useRef<ResizeObserver | null>(null);
  const fitToContent = useCallback((element: HTMLTextAreaElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!element) return;
    resizeTextareaToContent(element);
    let width = element.clientWidth;
    observerRef.current = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resizeTextareaToContent(element);
    });
    observerRef.current.observe(element);
  }, []);
  const long = LONG_FIELDS.has(field.name.toLowerCase()) || text.length > 48 || text.includes("\n");
  const save = (value: string) => {
    if (value === text) return judge("accepted");
    const raw = encodeValue(value, style, props.macros);
    judge(raw === null ? "refused" : "accepted");
    if (raw !== null) props.onCommit(raw);
  };
  const name = field.name;
  const common = {
    id,
    defaultValue: text,
    readOnly: !props.editable,
    spellCheck: false,
    "aria-invalid": invalid || undefined,
    onBlur: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => save(event.currentTarget.value),
  };
  const revert = (target: HTMLInputElement | HTMLTextAreaElement) => {
    target.value = text;
    judge("accepted");
    leaveField(target);
  };
  return (
    <div className="bib-field" data-style={style}>
      <label htmlFor={id} className="bib-field-name">{name}</label>
      {long ? (
        <Textarea
          {...common}
          rows={1}
          className="bib-field-value"
          ref={fitToContent}
          onInput={(event) => resizeTextareaToContent(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) leaveField(event.currentTarget);
            if (event.key === "Escape") revert(event.currentTarget);
          }}
        />
      ) : (
        <Input
          {...common}
          controlSize="compact"
          className="bib-field-value"
          onKeyDown={(event) => {
            if (event.key === "Enter") leaveField(event.currentTarget);
            if (event.key === "Escape") revert(event.currentTarget);
          }}
        />
      )}
      {props.editable && (
        <IconButton size="compact" className="bib-field-remove" label={t`Remove the ${name} field`} onClick={props.onRemove}>
          <X size={13} aria-hidden="true" />
        </IconButton>
      )}
      {invalid && (
        <InlineMessage level="error" className="bib-field-error">
          {style === "raw" ? t`This value joins strings with #; keep it valid BibTeX.` : t`Braces in the value must be balanced.`}
        </InlineMessage>
      )}
    </div>
  );
}
