import { useMemo, useState } from "react";
import { BookMarked, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "./components/ui/button";
import { CheckboxField } from "./components/ui/checkbox-field";
import { Input } from "./components/ui/input";
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
} from "./components/ui/select";
import { PanelHeader } from "./components/ui/panel-header";
import { popupMotionClassName } from "./components/ui/popup-motion";
import { SearchField } from "./components/ui/search-field";
import { ResizableDrawer } from "./resizable-drawer";

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
              <SearchField
                aria-label="Citation resolve query"
                value={resolveQuery}
                onChange={(event) => setResolveQuery(event.target.value)}
                onClear={() => setResolveQuery("")}
                placeholder="10.1038/… or arXiv:1706.03762 or paper title"
                onKeyDown={(event) => {
                  if (event.key === "Enter" && resolveQuery.trim() && !props.resolving && !props.busy) {
                    event.preventDefault();
                    void props.onResolve?.(resolveQuery).then((resolved) => {
                      if (resolved) applyResolved(resolved);
                    });
                  }
                }}
                showIcon={false}
              />
              <Button
                disabled={!resolveQuery.trim() || props.resolving || props.busy}
                onClick={() => {
                  void props.onResolve?.(resolveQuery).then((resolved) => {
                    if (resolved) applyResolved(resolved);
                  });
                }}
              >
                {props.resolving ? "Resolving…" : "Resolve"}
              </Button>
            </div>
          </label>
        )}
          <label>
            Type
            <Select value={type} onValueChange={(value) => setType(value as BibEntryType)}>
              <SelectTrigger aria-label="Entry type"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                {BIB_ENTRY_TYPES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label>
            Citation key
            <Input
              aria-label="Citation key"
              value={key}
              readOnly={editing}
              onChange={(event) => setKey(event.target.value)}
              placeholder={draft.key || "author2024title"}
            />
          </label>
          <label>
            Title
            <Input aria-label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Author
            <Input aria-label="Author" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Last, First and Last, First" />
          </label>
          <label>
            Year
            <div className="year-stepper">
              <Input aria-label="Year" value={year} onChange={(event) => setYear(event.target.value)} inputMode="numeric" />
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
                <SearchField
                  aria-label="Venue"
                  value={venue}
                  placeholder="NeurIPS, CVPR, Nature, …"
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
              <Input value={publisher} onChange={(event) => setPublisher(event.target.value)} />
            </label>
          )}
          <label>
            DOI
            <Input aria-label="DOI" value={doi} onChange={(event) => setDoi(event.target.value)} placeholder="10.…" />
          </label>
          <label>
            URL
            <Input value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          {!editing && (
            <CheckboxField
              checked={insertCite}
              label="Insert cite at cursor after saving"
              onChange={(event) => setInsertCite(event.target.checked)}
            />
          )}
        </div>
        <pre className="bib-entry-preview" aria-label="BibTeX preview">{formatBibEntry(draft)}</pre>
        {props.error && <p className="dialog-error" role="alert">{props.error}</p>}
        <div className="table-generator-actions">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={props.busy || props.resolving || !title.trim() || !author.trim() || !year.trim()}
            onClick={() => props.onSave(draft, insertCite)}
          >
            {props.busy ? "Saving…" : editing ? "Save changes" : "Save entry"}
          </Button>
        </div>
    </ResizableDrawer>
  );
}
