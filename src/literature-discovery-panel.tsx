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

export type OpenAlexWork = {
  id: string;
  title: string;
  year?: number | null;
  citedByCount: number;
  doi?: string | null;
  arxivId?: string | null;
  landingUrl?: string | null;
  authors: string[];
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function LiteratureDiscoveryPanel(props: {
  onClose: () => void;
  onImportArxiv: (arxivId: string) => Promise<void> | void;
  onAddBib: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [precise, setPrecise] = useState(true);
  const [results, setResults] = useState<OpenAlexWork[]>([]);
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
      const next = await invoke<OpenAlexWork[]>("search_openalex", {
        query: trimmed,
        precise,
      });
      setResults(next);
      if (!next.length) setNotice("No OpenAlex hits. Try broader terms or turn off precise mode.");
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
          Search OpenAlex for candidates. Import an arXiv PDF snapshot only when you intend to cite it; until then these hits stay outside project evidence.
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
          {results.map((work) => (
            <article className="literature-result" key={work.id}>
              <div className="literature-result-body">
                <strong>{work.title}</strong>
                <p>
                  {[
                    work.authors.slice(0, 3).join(", ") + (work.authors.length > 3 ? " et al." : ""),
                    work.year ? String(work.year) : null,
                    `${work.citedByCount} cites`,
                  ].filter(Boolean).join(" · ")}
                </p>
                <div className="literature-result-ids">
                  {work.arxivId ? <em>arXiv:{work.arxivId}</em> : null}
                  {work.doi ? <em>{work.doi}</em> : null}
                </div>
              </div>
              <div className="literature-result-actions">
                {work.arxivId ? (
                  <button
                    type="button"
                    disabled={busyId === work.id}
                    title="Import arXiv snapshot + bibliography entry"
                    onClick={() => {
                      setBusyId(work.id);
                      setError("");
                      Promise.resolve(props.onImportArxiv(work.arxivId!))
                        .then(() => setNotice(`Imported arXiv:${work.arxivId}`))
                        .catch((reason) => setError(message(reason)))
                        .finally(() => setBusyId(null));
                    }}
                  >
                    {busyId === work.id ? <LoaderCircle className="spin" size={13} /> : <BookOpen size={13} />}
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
          ))}
          {!loading && !results.length && !error && !notice && (
            <p className="empty-history">Search OpenAlex to find related work before importing evidence.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
