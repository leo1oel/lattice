/**
 * The bench's answer to `resolve_citation_query`, the lookup Add papers runs
 * for every pasted identifier or title, in the shape the backend serializes
 * (models.rs `ResolvedCitation`): always a whole record, never null.
 *
 * An arXiv id (bare, `arXiv:`-prefixed or an arxiv.org link) resolves to an
 * arXiv record, a DOI to a journal article, any other link to a webpage, and
 * anything else to the article of that title. `?lookup=choose` has a title
 * match two records, so its card waits for a choice; `?lookup=failed` fails
 * every lookup as the network would. Each answer lands after a short pause,
 * so the cards show "Looking up…" first.
 */
type Args = Record<string, unknown> | undefined;

const PAUSE_MS = 600;
const ARXIV = /^(?:arxiv:\s*|https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;
const DOI = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** Works the bench names by their real titles; any other id gets a stand-in. */
const KNOWN: Record<string, { title: string; author: string; year: string }> = {
  "2312.00752": { title: "Mamba: Linear-Time Sequence Modeling with Selective State Spaces", author: "Gu, Albert and Dao, Tri", year: "2023" },
  "1706.03762": { title: "Attention Is All You Need", author: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob", year: "2017" },
  "10.1038/s41586-021-03819-2": { title: "Highly accurate protein structure prediction with AlphaFold", author: "Jumper, John and Evans, Richard and Pritzel, Alexander", year: "2021" },
};

type ResolvedCitation = {
  key: string; title: string; author: string; year: string; journal: string; booktitle: string;
  publisher: string; url: string; doi: string; entryType: string; bibtex: string;
  candidates: ResolvedCitation[]; extraFields: Record<string, string>;
};

function record(entryType: string, fields: { title: string; author: string; year: string; url: string; doi?: string; journal?: string; publisher?: string }, extra: Record<string, string> = {}): ResolvedCitation {
  const surname = fields.author.split(",")[0].toLowerCase().replace(/[^a-z]/g, "") || "anon";
  const key = `${surname}${fields.year}${fields.title.toLowerCase().match(/[a-z]{4,}/)?.[0] ?? "work"}`;
  const all: Record<string, string> = {
    author: fields.author, title: `{${fields.title}}`, year: fields.year, url: fields.url,
    ...fields.journal ? { journal: fields.journal } : {}, ...fields.publisher ? { publisher: fields.publisher } : {},
    ...fields.doi ? { doi: fields.doi } : {}, ...extra,
  };
  const body = Object.keys(all).sort().map((name) => `  ${name} = {${all[name]}},`).join("\n");
  return {
    key, title: `{${fields.title}}`, author: fields.author, year: fields.year,
    journal: fields.journal ?? "", booktitle: "", publisher: fields.publisher ?? "",
    url: fields.url, doi: fields.doi ?? "", entryType,
    bibtex: `@${entryType}{${key},\n${body}\n}\n`, candidates: [], extraFields: extra,
  };
}

/** The record the backend would resolve `query` to. */
function resolvedCitation(query: string, params: URLSearchParams): ResolvedCitation {
  const value = query.trim();
  const arxiv = ARXIV.exec(value)?.[1];
  if (arxiv) {
    const known = KNOWN[arxiv] ?? { title: `A preprint filed as arXiv:${arxiv}`, author: "Writer, Bench", year: `20${arxiv.slice(0, 2)}` };
    return record("misc", { ...known, url: `https://arxiv.org/abs/${arxiv}` }, {
      archiveprefix: "arXiv", eprint: arxiv, howpublished: `arXiv preprint arXiv:${arxiv}`,
    });
  }
  const doi = DOI.exec(value)?.[1].toLowerCase();
  if (doi) {
    const known = KNOWN[doi] ?? { title: `An article with the DOI ${doi}`, author: "Writer, Bench", year: "2024" };
    return record("article", { ...known, doi, url: `https://doi.org/${doi}`, journal: "Journal of Bench Studies", publisher: "Bench Press" });
  }
  if (/^https?:\/\//i.test(value)) {
    return record("misc", { title: `The page at ${new URL(value).hostname}`, author: "Writer, Bench", year: "2025", url: value });
  }
  const article = (year: string, journal: string) => record("article", {
    title: value, author: "Writer, Bench", year, journal, url: "", doi: `10.5555/bench.${year}.${value.length}`,
  });
  if (params.get("lookup") === "choose") {
    return { ...record("misc", { title: "", author: "", year: "", url: "" }), key: "", bibtex: "", candidates: [article("2024", "Journal of Bench Studies"), article("1987", "Bench Quarterly")] };
  }
  return article("2024", "Journal of Bench Studies");
}

/** `resolve_citation_query`'s answer, a moment later, or the failure `?lookup=failed` stages. */
export function citationLookupAnswer(args: Args, params: URLSearchParams): Promise<ResolvedCitation> {
  const query = typeof args?.query === "string" ? args.query : "";
  return new Promise((resolve, reject) => window.setTimeout(() => {
    // The backend's own wording for a lookup that could not reach its source.
    if (params.get("lookup") === "failed") reject("Could not check for same-title records: error sending request. Retry or supply a DOI.");
    else resolve(resolvedCitation(query, params));
  }, PAUSE_MS));
}
