import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  ExternalLink,
  LoaderCircle,
  Quote,
  Search,
  X,
} from "lucide-react";

export type LiteratureHit = {
  source: "alphaxiv" | "openalex" | string;
  arxivId?: string | null;
  title: string;
  year?: number | null;
  authors: string[];
  citedByCount?: number | null;
  votes?: number | null;
  snippet?: string | null;
  doi?: string | null;
  landingUrl?: string | null;
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function hitKey(work: LiteratureHit): string {
  return `${work.source}:${work.arxivId ?? work.doi ?? work.title}`;
}

function hitMeta(work: LiteratureHit): string {
  if (work.source === "alphaxiv") {
    return [work.year ? String(work.year) : null, work.votes != null ? `▲ ${work.votes}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    work.authors.slice(0, 3).join(", ") + (work.authors.length > 3 ? " et al." : ""),
    work.year ? String(work.year) : null,
    work.citedByCount != null ? `${work.citedByCount} cites` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LiteratureDiscoveryPanel(props: {
  onClose: () => void;
  onImportArxiv: (arxivId: string) => Promise<void> | void;
  onAddBib: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [precise, setPrecise] = useState(true);
  const [results, setResults] = useState<LiteratureHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const search = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await invoke<LiteratureHit[]>("search_literature", {
        query: trimmed,
        precise,
      });
      setResults(next);
      if (!next.length) setNotice("No hits. Try broader terms or turn off precise mode.");
    } catch (reason) {
      setResults([]);
      setError(message(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer literature-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><Search size={16} /><span>Discover literature</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          alphaXiv full-text first, then OpenAlex citations (arXiv-only). Import an arXiv snapshot only when you intend to cite it; until then these hits stay outside project evidence.
        </p>
        <form
          className="literature-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            type="search"
            placeholder="Attention Is All You Need, diffusion, …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <label className="literature-precise">
            <input
              type="checkbox"
              checked={precise}
              onChange={(event) => setPrecise(event.target.checked)}
            />
            Title/abstract only
          </label>
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}
            Search
          </button>
        </form>
        {error ? <p className="history-diff-error">{error}</p> : null}
        {notice ? <p className="git-notice">{notice}</p> : null}
        <div className="literature-results">
          {results.map((work) => {
            const key = hitKey(work);
            return (
            <article className="literature-result" key={key}>
              <div className="literature-result-body">
                <span className={`lit-source lit-source-${work.source}`}>
                  {work.source === "alphaxiv" ? "alphaXiv · full-text" : "openalex · citations"}
                </span>
                <strong>{work.title}</strong>
                <p>{hitMeta(work)}</p>
                {work.snippet ? <p className="lit-snippet">{work.snippet}</p> : null}
                <div className="literature-result-ids">
                  {work.arxivId ? <em>arXiv:{work.arxivId}</em> : null}
                  {work.doi ? <em>{work.doi}</em> : null}
                </div>
              </div>
              <div className="literature-result-actions">
                {work.arxivId ? (
                  <button
                    type="button"
                    disabled={busyId === key}
                    title="Import arXiv snapshot + bibliography entry"
                    onClick={() => {
                      setBusyId(key);
                      setError("");
                      Promise.resolve(props.onImportArxiv(work.arxivId!))
                        .then(() => setNotice(`Imported arXiv:${work.arxivId}`))
                        .catch((reason) => setError(message(reason)))
                        .finally(() => setBusyId(null));
                    }}
                  >
                    {busyId === key ? <LoaderCircle className="spin" size={13} /> : <BookOpen size={13} />}
                    Import
                  </button>
                ) : null}
                <button
                  type="button"
                  title="Resolve into bibliography entry"
                  onClick={() => props.onAddBib(work.doi || work.title)}
                >
                  <Quote size={13} /> Bib
                </button>
                {work.landingUrl || work.doi ? (
                  <a
                    href={work.landingUrl || `https://doi.org/${work.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open landing page"
                  >
                    <ExternalLink size={13} />
                  </a>
                ) : null}
              </div>
            </article>
            );
          })}
          {!loading && !results.length && !error && !notice && (
            <p className="empty-history">Search alphaXiv and OpenAlex to find related work before importing evidence.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
