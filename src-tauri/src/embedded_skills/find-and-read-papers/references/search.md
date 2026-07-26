# Search details

Load this when walking a seed graph, decoding OpenAlex fields, handling odd alphaXiv ids, or recovering from empty results.

## alphaXiv hits

Response fields: `paperId`, `title`, `abstract`, `publicationDate`, `votes`, `snippets`.
Feed `paperId` into overview / `arxiv2md` only when it matches `\d{4}\.\d{4,5}` (optional `vN`).
Slug-style ids are often blogs or other sources — resolve before treating them as papers:

```bash
curl -sL "https://api.alphaxiv.org/papers/v3/<paperId>"
```

Check `sourceUrl` / `sourceName`. Prefer classic arXiv ids when choosing what to deep-read.
Use `snippets` to decide which hits deserve a read.
Widen `limit` only when the top set is thin.
alphaXiv is arXiv-heavy (CS/math/physics/stats/…) — not PubMed.

## OpenAlex graph

Base: `https://api.openalex.org`.
Append `&api_key=$OPENALEX_API_KEY` when set.

Broad search (noisier than title/abstract filter):

```bash
curl -s "https://api.openalex.org/works?search=<terms>&per_page=20&select=id,title,publication_year,cited_by_count,ids&api_key=$OPENALEX_API_KEY"
```

Resolve a seed from an arXiv id:

```bash
curl -s "https://api.openalex.org/works/doi:10.48550/arXiv.<arxiv-id>?select=id,title,related_works,referenced_works,ids&api_key=$OPENALEX_API_KEY"
```

If that 404s, use `filter=title.search:<title>`.

From work id `W…`:

- `related_works` — algorithmic neighbors on the work object
- `referenced_works` — what it cites
- who cites it:

```bash
curl -s "https://api.openalex.org/works?filter=cites:<W-id>&per_page=50&select=id,title,publication_year,cited_by_count&sort=cited_by_count:desc&api_key=$OPENALEX_API_KEY"
```

Expand a batch of ids:

```bash
curl -s "https://api.openalex.org/works?filter=openalex_id:W1|W2|W3&select=id,title,publication_year,cited_by_count&api_key=$OPENALEX_API_KEY"
```

For brand-new or lightly cited papers, pair graph walks with an alphaXiv full-text query — the graph under-links recent work.
`abstract_inverted_index` is `{word: [positions]}`; rebuild plaintext by placing words at their positions when you need the abstract.
Pull an arXiv id from `ids.doi` when it looks like `10.48550/arXiv.<id>`.

## Merge

1. Prefer hits in both indexes, or strong snippets / high `cited_by_count`.
2. Dedupe on versionless arXiv id (`2401.12345`), unless versions themselves matter.
3. Present id, title, year, match reason — hand promising arXiv ids to the read path.

## Fallback

When both indexes miss, say so before switching, then try arXiv API or Hugging Face paper search for fresh ML preprints.
Use general web search only when the work is not in these indexes yet.
