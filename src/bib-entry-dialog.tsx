import { useMemo, useState } from "react";
import { BookMarked, ChevronDown, ChevronUp, X } from "lucide-react";
import {
  BIB_ENTRY_TYPES,
  formatBibEntry,
  slugifyCitationKey,
  type BibEntryDraft,
  type BibEntryType,
} from "./bib-entry";
import { VENUES } from "./venues";

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
  }), [author, booktitle, journal, key, normalizedDoi, publisher, title, type, url, year]);

  // The venue field is the journal (article) or booktitle (anything else); a
  // preprint (@misc) with no venue yet edits into booktitle and is promoted to
  // @inproceedings once a real venue is chosen.
  const venue = type === "article" ? journal : booktitle;
  const setVenueText = (value: string) => {
    if (type === "article") setJournal(value);
    else setBooktitle(value);
  };
  const venueMatches = useMemo(() => {
    const query = venue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!query) return [];
    const tokens = query.split(" ");
    return VENUES.filter((item) => tokens.every((token) => item.search.includes(token))).slice(0, 8);
  }, [venue]);
  const chooseVenue = (choice: (typeof VENUES)[number]) => {
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
    if (Number.isFinite(parsed)) setYear(String(parsed + delta));
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
  };

  const heading = editing ? "Edit bibliography entry" : "Add bibliography entry";

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="bib-entry-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label={heading}>
        <div className="drawer-header">
          <div><BookMarked size={16} /><span>{heading}</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          {editing
            ? "Pick a venue to set its canonical name and entry type, or edit any field by hand."
            : "Resolve a DOI, arXiv id, or title with bibcite, or fill the fields by hand. Optionally insert a cite command at the cursor."}
        </p>
        <div className="bib-entry-form">
        {!editing && props.onResolve && (
          <label className="bib-resolve-field">
            Resolve from DOI / arXiv / title
            <div className="bib-resolve-row">
              <input
                aria-label="Citation resolve query"
                value={resolveQuery}
                onChange={(event) => setResolveQuery(event.target.value)}
                placeholder="10.1038/… or arXiv:1706.03762 or paper title"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && resolveQuery.trim() && !props.resolving && !props.busy) {
                    event.preventDefault();
                    void props.onResolve?.(resolveQuery).then((resolved) => {
                      if (resolved) applyResolved(resolved);
                    });
                  }
                }}
              />
              <button
                type="button"
                className="secondary"
                disabled={!resolveQuery.trim() || props.resolving || props.busy}
                onClick={() => {
                  void props.onResolve?.(resolveQuery).then((resolved) => {
                    if (resolved) applyResolved(resolved);
                  });
                }}
              >
                {props.resolving ? "Resolving…" : "Resolve"}
              </button>
            </div>
          </label>
        )}
          <label>
            Type
            <select aria-label="Entry type" value={type} onChange={(event) => setType(event.target.value as BibEntryType)}>
              {BIB_ENTRY_TYPES.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            Citation key
            <input
              aria-label="Citation key"
              value={key}
              readOnly={editing}
              onChange={(event) => setKey(event.target.value)}
              placeholder={draft.key || "author2024title"}
            />
          </label>
          <label>
            Title
            <input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Author
            <input aria-label="Author" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Last, First and Last, First" />
          </label>
          <label>
            Year
            <div className="year-stepper">
              <input aria-label="Year" value={year} onChange={(event) => setYear(event.target.value)} inputMode="numeric" />
              <div className="year-stepper-buttons">
                <button type="button" aria-label="Increment year" onClick={() => stepYear(1)}><ChevronUp size={12} /></button>
                <button type="button" aria-label="Decrement year" onClick={() => stepYear(-1)}><ChevronDown size={12} /></button>
              </div>
            </div>
          </label>
          {type !== "book" && (
            <label>
              Venue
              <div className="venue-combobox">
                <input
                  aria-label="Venue"
                  value={venue}
                  placeholder="NeurIPS, CVPR, Nature, …"
                  onChange={(event) => { setVenueText(event.target.value); setVenueOpen(true); }}
                  onFocus={() => setVenueOpen(true)}
                  onBlur={() => setVenueOpen(false)}
                />
                {venueOpen && venueMatches.length > 0 && (
                  <div className="venue-menu" role="listbox">
                    {venueMatches.map((item) => (
                      <button
                        key={item.name}
                        type="button"
                        role="option"
                        aria-selected={item.name === venue}
                        onMouseDown={(event) => { event.preventDefault(); chooseVenue(item); }}
                      >
                        <span>{item.name}</span>
                        <em>{item.entryType === "article" ? "journal" : "conference"}</em>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </label>
          )}
          {type === "book" && (
            <label>
              Publisher
              <input value={publisher} onChange={(event) => setPublisher(event.target.value)} />
            </label>
          )}
          <label>
            DOI
            <input aria-label="DOI" value={doi} onChange={(event) => setDoi(event.target.value)} placeholder="10.…" />
          </label>
          <label>
            URL
            <input value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          {!editing && (
            <label className="settings-checkbox">
              <input type="checkbox" checked={insertCite} onChange={(event) => setInsertCite(event.target.checked)} />
              <span>Insert cite at cursor after saving</span>
            </label>
          )}
        </div>
        <pre className="bib-entry-preview" aria-label="BibTeX preview">{formatBibEntry(draft)}</pre>
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        <div className="table-generator-actions">
          <button type="button" className="secondary" onClick={props.onClose}>Cancel</button>
          <button
            type="button"
            disabled={props.busy || props.resolving || !title.trim() || !author.trim() || !year.trim()}
            onClick={() => props.onSave(draft, insertCite)}
          >
            {props.busy ? "Saving…" : editing ? "Save changes" : "Save entry"}
          </button>
        </div>
      </aside>
    </div>
  );
}
