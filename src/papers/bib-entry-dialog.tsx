import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, ChevronDown, ChevronUp } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Input } from "../components/ui/input";
import {
  BIB_ENTRY_TYPES,
  formatBibEntry,
  slugifyCitationKey,
  type BibEntryDraft,
  type BibEntryType,
} from "./bib-entry";
import { VENUES } from "./venues";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { PanelHeader } from "../components/ui/panel-header";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { SearchField } from "../components/ui/search-field";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

export type ResolvedCitationDraft = {
  key: string;
  title: string;
  author: string;
  year: string;
  journal: string;
  booktitle: string;
  publisher: string;
  url: string;
  doi: string;
  entryType: string;
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

const ENTRY_TYPES = ["article", "inproceedings", "book", "misc"] as const;

function inferType(draft?: ResolvedCitationDraft): BibEntryType {
  if (draft && ENTRY_TYPES.includes(draft.entryType as BibEntryType)) {
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
  const [type, setType] = useState<BibEntryType>(() => inferType(seed));
  const [key, setKey] = useState(seed?.key ?? "");
  const [title, setTitle] = useState(seed?.title ?? "");
  const [author, setAuthor] = useState(seed?.author ?? "");
  const [year, setYear] = useState(seed?.year ?? "");
  const [journal, setJournal] = useState(seed?.journal ?? "");
  const [booktitle, setBooktitle] = useState(seed?.booktitle ?? "");
  const [publisher, setPublisher] = useState(seed?.publisher ?? "");
  const [url, setUrl] = useState(seed?.url ?? "");
  const [doi, setDoi] = useState(seed?.doi ?? "");
  const [insertCite, setInsertCite] = useState(!editing);
  const [resolveQuery, setResolveQuery] = useState(props.initialResolveQuery ?? "");
  const [venueOpen, setVenueOpen] = useState(false);
  const [candidates, setCandidates] = useState<ResolvedCitationDraft[]>([]);
  const [evidence, setEvidence] = useState<ResolvedCitationDraft["evidence"]>(seed?.evidence);
  const [extraFields, setExtraFields] = useState<Record<string, string> | undefined>(seed?.extraFields);
  const [retrievedEdited, setRetrievedEdited] = useState(false);
  const [resolveInFlight, setResolveInFlight] = useState(false);
  const requestGeneration = useRef(0);
  const requestInFlight = useRef(false);

  useEffect(() => () => {
    requestGeneration.current += 1;
  }, []);

  const normalizedDoi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
  const draft: BibEntryDraft = useMemo(() => ({
    type,
    key: key.trim() || slugifyCitationKey(title, author, year),
    title,
    author,
    year,
    journal,
    booktitle,
    publisher,
    url: url || (normalizedDoi ? `https://doi.org/${normalizedDoi}` : ""),
    doi: normalizedDoi || undefined,
    extraFields,
  }), [author, booktitle, extraFields, journal, key, normalizedDoi, publisher, title, type, url, year]);

  // The venue field is the journal (article) or booktitle (anything else); a
  // preprint (@misc) with no venue yet edits into booktitle and is promoted to
  // @inproceedings once a real venue is chosen.
  const venue = type === "article" ? journal : booktitle;
  const setVenueText = (value: string) => {
    if (type === "article") setJournal(value);
    else setBooktitle(value);
    if (evidence) setRetrievedEdited(true);
  };
  const venueMatches = useMemo(() => {
    const query = venue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!query) return [];
    const tokens = query.split(" ");
    return VENUES.filter((item) => tokens.every((token) => item.search.includes(token))).slice(0, 8);
  }, [venue]);
  const chooseVenue = (choice: (typeof VENUES)[number]) => {
    if (evidence) setRetrievedEdited(true);
    setType(choice.entryType);
    if (choice.entryType === "article") {
      setJournal(choice.name);
      setBooktitle("");
    } else {
      setBooktitle(choice.name);
      setJournal("");
    }
    setVenueOpen(false);
  };

  const stepYear = (delta: number) => {
    const parsed = Number.parseInt(year, 10);
    if (Number.isFinite(parsed)) changeResolvedField(() => setYear(String(parsed + delta)));
  };

  if (!props.open) return null;

  const applyResolved = (resolved: ResolvedCitationDraft) => {
    setType(inferType(resolved));
    setKey(resolved.key);
    setTitle(resolved.title);
    setAuthor(resolved.author);
    setYear(resolved.year);
    setJournal(resolved.journal);
    setBooktitle(resolved.booktitle);
    setPublisher(resolved.publisher);
    setUrl(resolved.url);
    setDoi(resolved.doi);
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

  const changeResolvedField = (change: () => void) => {
    change();
    if (evidence) setRetrievedEdited(true);
  };

  const heading = editing ? t`Edit bibliography entry` : t`Add bibliography entry`;
  // `BIB_ENTRY_TYPES` is BibTeX data whose `value` is the wire format; only the
  // menu label is prose, so it is translated here rather than in the catalog.
  const entryTypeLabel: Record<BibEntryType, string> = {
    article: t`Article`,
    inproceedings: t`In proceedings`,
    book: t`Book`,
    misc: t`Misc`,
  };

  return (
    <ResizableDrawer
      className="bib-entry-dialog"
      ariaLabel={heading}
      onClose={props.onClose}
    >
        <PanelHeader
          className="drawer-header"
          icon={<BookMarked size={16} />}
          title={heading}
          onClose={props.onClose}
        />
        {editing && (
          <p className="drawer-copy">
            {t`Pick a venue to set its canonical name and entry type, or edit any field by hand`}
          </p>
        )}
        <div className="bib-entry-form">
        {!editing && props.onResolve && (
          <label className="bib-resolve-field">
            {t`Resolve from DOI / arXiv / title`}
            <div className="bib-resolve-row">
              <SearchField
                aria-label={t`Citation resolve query`}
                value={resolveQuery}
                onChange={(event) => {
                  requestGeneration.current += 1;
                  requestInFlight.current = false;
                  setResolveInFlight(false);
                  setCandidates([]);
                  setResolveQuery(event.target.value);
                }}
                onClear={() => {
                  requestGeneration.current += 1;
                  requestInFlight.current = false;
                  setResolveInFlight(false);
                  setCandidates([]);
                  setResolveQuery("");
                }}
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
                disabled={!resolveQuery.trim() || props.resolving || resolveInFlight || props.busy}
                onClick={() => void resolveCitation()}
              >
                {props.resolving || resolveInFlight ? t`Resolving…` : t`Resolve`}
              </Button>
            </div>
          </label>
        )}
        {candidates.length > 0 && (
          <section className="bib-citation-records" aria-label={t`Citation candidates`}>
            <p>{t`Choose the matching record before saving`}</p>
            {candidates.map((candidate, index) => (
              <article key={`${candidate.key}-${index}`}>
                <strong>{candidate.title}</strong>
                <p>{candidate.author || t`Authors unavailable`} · {candidate.year || t`Year unavailable`}</p>
                <p>{candidate.journal || candidate.booktitle || candidate.publisher || t`Venue unavailable`}</p>
                <CitationEvidence evidence={candidate.evidence} authorsPresent={Boolean(candidate.author)} />
                <Button onClick={() => applyResolved(candidate)}>{t`Select this record`}</Button>
              </article>
            ))}
          </section>
        )}
        {evidence && (
          <section className="bib-citation-records" aria-label={t`Retrieved record information`}>
            <CitationEvidence evidence={evidence} authorsPresent={Boolean(author)} />
            {retrievedEdited && <p>{t`This match information describes the retrieved record; you have edited its fields.`}</p>}
          </section>
        )}
          <label>
            {t`Type`}
            <Select value={type} onValueChange={(value) => changeResolvedField(() => setType(value as BibEntryType))}>
              <SelectTrigger aria-label={t`Entry type`}><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                {BIB_ENTRY_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{entryTypeLabel[item.value]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            {t`Citation key`}
            <Input
              aria-label={t`Citation key`}
              value={key}
              readOnly={editing}
              onChange={(event) => changeResolvedField(() => setKey(event.target.value))}
              placeholder={draft.key || "author2024title"}
            />
          </label>
          <label>
            {t`Title`}
            <Input aria-label={t`Title`} value={title} onChange={(event) => changeResolvedField(() => setTitle(event.target.value))} />
          </label>
          <label>
            {t`Author`}
            <Input aria-label={t`Author`} value={author} onChange={(event) => changeResolvedField(() => setAuthor(event.target.value))} placeholder={t`Last, First and Last, First`} />
          </label>
          <label>
            {t`Year`}
            <div className="year-stepper">
              <Input aria-label={t`Year`} value={year} onChange={(event) => changeResolvedField(() => setYear(event.target.value))} inputMode="numeric" />
              <div className="year-stepper-buttons">
                <button type="button" aria-label={t`Increment year`} onClick={() => stepYear(1)}><ChevronUp size={12} /></button>
                <button type="button" aria-label={t`Decrement year`} onClick={() => stepYear(-1)}><ChevronDown size={12} /></button>
              </div>
            </div>
          </label>
          {type !== "book" && (
            <label>
              {t`Venue`}
              <div className="venue-combobox">
                <SearchField
                  aria-label={t`Venue`}
                  value={venue}
                  placeholder={t`NeurIPS, CVPR, Nature, …`}
                  onChange={(event) => { setVenueText(event.target.value); setVenueOpen(true); }}
                  onClear={() => { setVenueText(""); setVenueOpen(true); }}
                  onFocus={() => setVenueOpen(true)}
                  onBlur={() => setVenueOpen(false)}
                />
                {venueOpen && venueMatches.length > 0 && (
                  <div className={`venue-menu ${popupMotionClassName}`} role="listbox">
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
          {type === "book" && (
            <label>
              {t`Publisher`}
              <Input value={publisher} onChange={(event) => changeResolvedField(() => setPublisher(event.target.value))} />
            </label>
          )}
          <label>
            DOI
            <Input aria-label="DOI" value={doi} onChange={(event) => changeResolvedField(() => setDoi(event.target.value))} placeholder="10.…" />
          </label>
          <label>
            URL
            <Input value={url} onChange={(event) => changeResolvedField(() => setUrl(event.target.value))} />
          </label>
          {!editing && (
            <CheckboxField
              checked={insertCite}
              label={t`Insert cite at cursor after saving`}
              onChange={(event) => setInsertCite(event.target.checked)}
            />
          )}
        </div>
        <pre className="bib-entry-preview" aria-label={t`BibTeX preview`}>{formatBibEntry(draft)}</pre>
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        <div className="table-generator-actions">
          <Button variant="ghost" onClick={props.onClose}>{t`Cancel`}</Button>
          <Button
            variant="primary"
            disabled={props.busy || props.resolving || resolveInFlight || candidates.length > 0 || !title.trim() || !author.trim() || !year.trim()}
            onClick={() => props.onSave(draft, insertCite)}
          >
            {props.busy ? t`Saving…` : editing ? t`Save changes` : t`Save entry`}
          </Button>
        </div>
    </ResizableDrawer>
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
