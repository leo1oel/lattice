import { useMemo, useState } from "react";
import { BookMarked, X } from "lucide-react";
import {
  BIB_ENTRY_TYPES,
  formatBibEntry,
  slugifyCitationKey,
  type BibEntryDraft,
  type BibEntryType,
} from "./bib-entry";

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

export function BibEntryDialog(props: {
  open: boolean;
  busy: boolean;
  resolving?: boolean;
  error: string | null;
  initialResolveQuery?: string;
  onClose: () => void;
  onSave: (draft: BibEntryDraft, insertCite: boolean) => void;
  onResolve?: (query: string) => Promise<ResolvedCitationDraft | null>;
}) {
  const [type, setType] = useState<BibEntryType>("article");
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [journal, setJournal] = useState("");
  const [booktitle, setBooktitle] = useState("");
  const [publisher, setPublisher] = useState("");
  const [url, setUrl] = useState("");
  const [doi, setDoi] = useState("");
  const [insertCite, setInsertCite] = useState(true);
  const [resolveQuery, setResolveQuery] = useState(props.initialResolveQuery ?? "");

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

  if (!props.open) return null;

  const applyResolved = (resolved: ResolvedCitationDraft) => {
    const nextType = (["article", "inproceedings", "book", "misc"] as const)
      .includes(resolved.entryType as BibEntryType)
      ? resolved.entryType as BibEntryType
      : resolved.journal ? "article" as const
        : resolved.booktitle ? "inproceedings" as const
          : resolved.publisher ? "book" as const
            : "misc" as const;
    setType(nextType);
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

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="bib-entry-dialog" onMouseDown={(event) => event.stopPropagation()} aria-label="Add bibliography entry">
        <div className="drawer-header">
          <div><BookMarked size={16} /><span>Add bibliography entry</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">Resolve a DOI, arXiv id, or title with bibcite, or fill the fields by hand. Optionally insert a cite command at the cursor.</p>
        <div className="bib-entry-form">
        {props.onResolve && (
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
            <input aria-label="Citation key" value={key} onChange={(event) => setKey(event.target.value)} placeholder={draft.key || "author2024title"} />
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
            <input aria-label="Year" value={year} onChange={(event) => setYear(event.target.value)} />
          </label>
          {type === "article" && (
            <label>
              Journal
              <input value={journal} onChange={(event) => setJournal(event.target.value)} />
            </label>
          )}
          {type === "inproceedings" && (
            <label>
              Booktitle
              <input value={booktitle} onChange={(event) => setBooktitle(event.target.value)} />
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
          <label className="settings-checkbox">
            <input type="checkbox" checked={insertCite} onChange={(event) => setInsertCite(event.target.checked)} />
            <span>Insert cite at cursor after saving</span>
          </label>
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
            {props.busy ? "Saving…" : "Save entry"}
          </button>
        </div>
      </aside>
    </div>
  );
}
