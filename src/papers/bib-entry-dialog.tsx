import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, ChevronDown, ChevronRight, ChevronUp, PenLine } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Input, type InputProps } from "../components/ui/input";
import { BIB_ENTRY_TYPES, formatBibEntry, slugifyCitationKey, type BibEntryDraft, type BibEntryType } from "./bib-entry";
import { VENUES, type Venue } from "./venues";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { PanelHeader } from "../components/ui/panel-header";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { SearchField } from "../components/ui/search-field";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

/** The form's text fields; a seed or a resolved record replaces all of them at once. */
const TEXT_FIELDS = ["key", "title", "author", "year", "journal", "booktitle", "publisher", "url", "doi"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** A citation record from the resolver: every text field, plus how it was found. */
export type ResolvedCitationDraft = Record<TextField, string> & {
  entryType: string;
  bibtex?: string;
  candidates?: ResolvedCitationDraft[];
  evidence?: {
    source?: string;
    url?: string;
    title_match?: string;
    author_match?: string;
    [key: string]: unknown;
  };
  extraFields?: Record<string, string>;
};

function fieldsOf(draft?: ResolvedCitationDraft): Record<TextField, string> {
  return Object.fromEntries(TEXT_FIELDS.map((name) => [name, draft?.[name] ?? ""])) as Record<TextField, string>;
}

/**
 * What a lookup query already says about the work. Only a query that is
 * wholly a DOI, a link or an arXiv ID fills that field; anything else is
 * taken as the title.
 */
function fieldsFromQuery(query: string): Partial<Record<TextField, string>> {
  const value = query.trim();
  const doi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i.exec(value)?.[1];
  if (doi) return { doi };
  if (/^https?:\/\/\S+$/i.test(value)) return { url: value };
  const arxiv = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)$/i.exec(value)?.[1];
  if (arxiv) return { url: `https://arxiv.org/abs/${arxiv}` };
  return value ? { title: value } : {};
}

function inferType(draft?: ResolvedCitationDraft): BibEntryType {
  if (draft && (BIB_ENTRY_TYPES as readonly string[]).includes(draft.entryType)) {
    return draft.entryType as BibEntryType;
  }
  if (draft?.journal) return "article";
  if (draft?.booktitle) return "inproceedings";
  if (draft?.publisher) return "book";
  return draft ? "misc" : "article";
}

export function BibEntryDialog(props: {
  open: boolean;
  busy: boolean;
  resolving?: boolean;
  error: string | null;
  mode?: "add" | "edit";
  initialResolveQuery?: string;
  initialDraft?: ResolvedCitationDraft;
  onClose: () => void;
  onSave: (draft: BibEntryDraft, insertCite: boolean) => void;
  onResolve?: (query: string) => Promise<ResolvedCitationDraft | null>;
}) {
  const { t } = useLingui();
  const editing = props.mode === "edit";
  const seed = props.initialDraft;
  const [initialType] = useState<BibEntryType>(() => inferType(seed));
  const [initialFields] = useState(() => fieldsOf(seed));
  const [type, setType] = useState<BibEntryType>(initialType);
  const [fields, setFields] = useState(initialFields);
  const [insertCite, setInsertCite] = useState(!editing);
  const [resolveQuery, setResolveQuery] = useState(props.initialResolveQuery ?? "");
  const [venueOpen, setVenueOpen] = useState(false);
  const [candidates, setCandidates] = useState<ResolvedCitationDraft[]>(seed?.candidates ?? []);
  const [evidence, setEvidence] = useState<ResolvedCitationDraft["evidence"]>(seed?.evidence);
  const [extraFields, setExtraFields] = useState<Record<string, string> | undefined>(seed?.extraFields);
  const [retrievedEdited, setRetrievedEdited] = useState(false);
  const [resolveInFlight, setResolveInFlight] = useState(false);
  // A new entry starts at the lookup; the fields appear once a record is
  // chosen or the writer enters it by hand. Editing, a record handed over
  // whole, or a dialog without a resolver open on the fields.
  const [showFields, setShowFields] = useState(() => editing || !props.onResolve || Boolean(seed && !seed.candidates?.length));
  // Set when the writer moved to the fields, so the title takes the keyboard as they appear.
  const [focusFields, setFocusFields] = useState(false);
  const requestGeneration = useRef(0);
  const requestInFlight = useRef(false);

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const normalizedDoi = fields.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const draft: BibEntryDraft = useMemo(() => ({
    ...fields,
    type,
    key: fields.key.trim() || slugifyCitationKey(fields.title, fields.author, fields.year),
    url: fields.url || (normalizedDoi ? `https://doi.org/${normalizedDoi}` : ""),
    doi: normalizedDoi || undefined,
    extraFields,
  }), [extraFields, fields, normalizedDoi, type]);

  // Match information describes the retrieved record, so flag any later edit.
  const markEdited = () => {
    if (evidence) setRetrievedEdited(true);
  };
  const setField = (name: TextField, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    markEdited();
  };

  // The venue field is the journal (article) or booktitle (anything else); a
  // preprint (@misc) with no venue yet edits into booktitle and is promoted to
  // @inproceedings once a real venue is chosen.
  const venueField = type === "article" ? "journal" : "booktitle";
  const venue = fields[venueField];
  const venueMatches = useMemo(() => {
    const query = venue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!query) return [];
    const tokens = query.split(" ");
    return VENUES.filter((item) => tokens.every((token) => item.search.includes(token))).slice(0, 8);
  }, [venue]);
  const chooseVenue = (choice: Venue) => {
    markEdited();
    setType(choice.entryType);
    const article = choice.entryType === "article";
    setFields((current) => ({ ...current, journal: article ? choice.name : "", booktitle: article ? "" : choice.name }));
    setVenueOpen(false);
  };

  const stepYear = (delta: number) => {
    const parsed = Number.parseInt(fields.year, 10);
    if (Number.isFinite(parsed)) setField("year", String(parsed + delta));
  };

  if (!props.open) return null;

  const applyResolved = (resolved: ResolvedCitationDraft, chosen = false) => {
    setShowFields(true);
    if (chosen) setFocusFields(true);
    setType(inferType(resolved));
    setFields(fieldsOf(resolved));
    setEvidence(resolved.evidence);
    setExtraFields(resolved.extraFields);
    setRetrievedEdited(false);
    setCandidates([]);
  };

  const resolveCitation = async () => {
    const query = resolveQuery.trim();
    if (!query || requestInFlight.current || props.busy || props.resolving || !props.onResolve) return;
    requestInFlight.current = true;
    setResolveInFlight(true);
    const generation = ++requestGeneration.current;
    try {
      const resolved = await props.onResolve(query);
      if (generation !== requestGeneration.current) return;
      if (resolved?.candidates?.length) {
        setCandidates(resolved.candidates);
        setEvidence(undefined);
        setExtraFields(undefined);
      } else if (resolved) {
        applyResolved(resolved);
      }
    } finally {
      if (generation === requestGeneration.current) {
        requestInFlight.current = false;
        setResolveInFlight(false);
      }
    }
  };

  // A new query abandons the lookup in flight and the candidates it offered.
  const abandonLookup = () => {
    requestGeneration.current += 1;
    requestInFlight.current = false;
    setResolveInFlight(false);
    setCandidates([]);
  };
  const changeResolveQuery = (value: string) => {
    abandonLookup();
    setResolveQuery(value);
  };
  // Entering by hand declines every candidate and any lookup still running;
  // whatever the query already says about the work fills the fields still empty.
  const enterManually = () => {
    abandonLookup();
    const fromQuery = Object.entries(fieldsFromQuery(resolveQuery)) as [TextField, string][];
    setFields((current) => ({
      ...current,
      ...Object.fromEntries(fromQuery.filter(([name]) => !current[name].trim())),
    }));
    setShowFields(true);
    setFocusFields(true);
  };

  const textField = (name: TextField, label: string, extra?: InputProps) => (
    <label>
      {label}
      <Input aria-label={label} value={fields[name]} onChange={(event) => setField(name, event.target.value)} {...extra} />
    </label>
  );

  const heading = editing ? t`Edit bibliography entry` : t`Add bibliography entry`;
  // Anything typed or picked since the dialog opened; a click outside must not throw it away.
  const dirty = type !== initialType || TEXT_FIELDS.some((name) => fields[name] !== initialFields[name])
    || resolveQuery !== (props.initialResolveQuery ?? "") || insertCite !== !editing;
  // `BIB_ENTRY_TYPES` is BibTeX wire format; only the menu label is prose.
  const entryTypeLabel: Record<BibEntryType, string> = {
    article: t`Article`,
    inproceedings: t`In proceedings`,
    book: t`Book`,
    misc: t`Misc`,
  };

  return (
    <SheetDialog className={showFields ? "bib-entry-dialog" : "bib-entry-dialog bib-entry-lookup"} label={heading} dirty={dirty} onClose={props.onClose}>
      <PanelHeader className="drawer-header" icon={<BookMarked size={16} />} title={heading} onClose={props.onClose} />
      <div className="bib-entry-form">
        {!editing && props.onResolve && (
          <label className="bib-resolve-field">
            {t`Resolve from DOI / arXiv / title`}
            <div className="bib-resolve-row">
              <SearchField
                autoFocus
                aria-label={t`Citation resolve query`}
                value={resolveQuery}
                onChange={(event) => changeResolveQuery(event.target.value)}
                onClear={() => changeResolveQuery("")}
                placeholder={t`10.1038/… or arXiv:1706.03762 or paper title`}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && resolveQuery.trim() && !props.resolving && !props.busy) {
                    event.preventDefault();
                    void resolveCitation();
                  }
                }}
                showIcon={false}
              />
              <Button
                variant={showFields ? "secondary" : "primary"}
                disabled={!resolveQuery.trim() || props.resolving || resolveInFlight || props.busy}
                onClick={() => void resolveCitation()}
              >
                {props.resolving || resolveInFlight ? t`Resolving…` : t`Resolve`}
              </Button>
            </div>
          </label>
        )}
        {!showFields && (
          <div className="bib-entry-manual">
            <Button variant="ghost" size="compact" onClick={enterManually}>
              <PenLine size={13} />
              {t`Enter manually`}
            </Button>
          </div>
        )}
        {!showFields && props.error && <p className="dialog-error bib-entry-lookup-error" role="alert">{props.error}</p>}
        {candidates.length > 0 && (
          <section className="bib-citation-records" aria-label={t`Citation candidates`}>
            <p>{t`Choose the matching record before saving`}</p>
            {candidates.map((candidate, index) => (
              <article key={`${candidate.key}-${index}`}>
                <strong>{candidate.title}</strong>
                <p>{candidate.author || t`Authors unavailable`} · {candidate.year || t`Year unavailable`}</p>
                <p>{candidate.journal || candidate.booktitle || candidate.publisher || t`Venue unavailable`}</p>
                <CitationEvidence evidence={candidate.evidence} authorsPresent={Boolean(candidate.author)} />
                <Button onClick={() => applyResolved(candidate, true)}>{t`Select this record`}</Button>
              </article>
            ))}
            {showFields && <Button variant="ghost" size="compact" onClick={abandonLookup}>{t`Keep my fields`}</Button>}
          </section>
        )}
        {evidence && (
          <section className="bib-citation-records" aria-label={t`Retrieved record information`}>
            <CitationEvidence evidence={evidence} authorsPresent={Boolean(fields.author)} />
            {retrievedEdited && <p>{t`This match information describes the retrieved record; you have edited its fields.`}</p>}
          </section>
        )}
        {showFields && <>
          <label>
            {t`Type`}
            <Select value={type} onValueChange={(value) => { setType(value as BibEntryType); markEdited(); }}>
              <SelectTrigger aria-label={t`Entry type`}><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                {BIB_ENTRY_TYPES.map((value) => <SelectItem key={value} value={value}>{entryTypeLabel[value]}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
          {textField("key", t`Citation key`, { readOnly: editing, placeholder: draft.key || "author2024title" })}
          {textField("title", t`Title`, { autoFocus: focusFields })}
          {textField("author", t`Author`, { placeholder: t`Last, First and Last, First` })}
          <label>
            {t`Year`}
            <div className="year-stepper">
              <Input aria-label={t`Year`} value={fields.year} onChange={(event) => setField("year", event.target.value)} inputMode="numeric" />
              <div className="year-stepper-buttons">
                <button type="button" aria-label={t`Increment year`} onClick={() => stepYear(1)}><ChevronUp size={12} /></button>
                <button type="button" aria-label={t`Decrement year`} onClick={() => stepYear(-1)}><ChevronDown size={12} /></button>
              </div>
            </div>
          </label>
          {type === "book" ? textField("publisher", t`Publisher`) : (
            <label>
              {t`Venue`}
              <div className="venue-combobox">
                <SearchField
                  aria-label={t`Venue`}
                  value={venue}
                  placeholder={t`NeurIPS, CVPR, Nature, …`}
                  onChange={(event) => { setField(venueField, event.target.value); setVenueOpen(true); }}
                  onClear={() => { setField(venueField, ""); setVenueOpen(true); }}
                  onFocus={() => setVenueOpen(true)}
                  onBlur={() => setVenueOpen(false)}
                />
                {venueOpen && venueMatches.length > 0 && (
                  <div className={`venue-menu fluid-hover-surface ${popupMotionClassName}`} role="listbox">
                    <FluidHoverSurface />
                    {venueMatches.map((item) => (
                      <button
                        key={item.name}
                        type="button"
                        role="option"
                        aria-selected={item.name === venue}
                        onMouseDown={(event) => { event.preventDefault(); chooseVenue(item); }}
                      >
                        <span>{item.name}</span>
                        <em>{item.entryType === "article" ? t`journal` : t`conference`}</em>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>
          )}
          {textField("doi", "DOI", { placeholder: "10.…" })}
          {textField("url", "URL")}
          {!editing && (
            <CheckboxField
              checked={insertCite}
              label={t`Insert cite at cursor after saving`}
              onChange={(event) => setInsertCite(event.target.checked)}
            />
          )}
        </>}
      </div>
      {showFields && (
        <details className="bib-entry-preview-disclosure">
          <summary><ChevronRight size={13} aria-hidden="true" />{t`BibTeX preview`}</summary>
          <pre className="bib-entry-preview" aria-label={t`BibTeX preview`}>{formatBibEntry(draft)}</pre>
        </details>
      )}
      {showFields && props.error && <p className="dialog-error" role="alert">{props.error}</p>}
      <div className="table-generator-actions">
        <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
        {showFields && (
          <Button
            variant="primary"
            disabled={props.busy || props.resolving || resolveInFlight || candidates.length > 0
              || !fields.title.trim() || !fields.author.trim() || !fields.year.trim()}
            onClick={() => props.onSave(draft, insertCite)}
          >
            {props.busy ? t`Saving…` : editing ? t`Save changes` : t`Save entry`}
          </Button>
        )}
      </div>
    </SheetDialog>
  );
}

function CitationEvidence(props: {
  evidence?: ResolvedCitationDraft["evidence"];
  authorsPresent: boolean;
}) {
  const { t } = useLingui();
  const { evidence } = props;
  const sourceUrl = evidence?.url && /^https?:\/\//i.test(evidence.url) ? evidence.url : undefined;
  const authorMatch = evidence?.author_match === "matched" ? t`Compatible author names`
    : evidence?.author_match === "partial" ? t`Partial author information`
      : props.authorsPresent ? t`Authors unchecked` : t`Authors unavailable and unchecked`;
  return (
    <div className="bib-citation-evidence">
      {evidence?.source && <span>{t`Source:`} {sourceUrl
        ? <a href={sourceUrl} target="_blank" rel="noreferrer">{evidence.source}</a> : evidence.source}</span>}
      {evidence?.title_match && <span>{evidence.title_match === "exact" ? t`Exact title match` : t`Similar title match`}</span>}
      <span>{authorMatch}</span>
    </div>
  );
}
