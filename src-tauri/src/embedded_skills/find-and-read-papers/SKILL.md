---
name: find-and-read-papers
description: Find related research papers and read them for evidence — related work, literature search, citation lineage, prior art, seed-paper expansion, or reading / summarizing / analyzing / fact-checking a preprint. Use whenever the user asks for papers on a topic, pastes an arXiv URL or id, or needs claims checked against the paper itself rather than a web summary.
compatibility: Runs inside a Lattice project. Requires network access, curl, and uv (for `uvx --from 'arxiv2markdown>=0.1,<0.2' arxiv2md`). Optional `OPENALEX_API_KEY` for higher OpenAlex rate limits.
---

# Find and read papers

Ground literature work in paper indexes and paper text.
Search alphaXiv and OpenAlex together — full-text and citation-graph hits cover different misses.
Read the alphaXiv overview to orient, then local `arxiv2md` for evidence, because overview text is not the paper.
Do not start with ad-hoc web search or raw PDF/HTML fetches from arxiv.org.

After the text is in hand, use `research-taste` for critique and taste.
For `.bib` / `\cite{...}`, use `bibcite` — this skill does not edit bibliographies.

## Where things go

The working directory is a Lattice project: a LaTeX manuscript that syncs to Overleaf and is committed to version history.
Nothing downloaded while reading belongs at its root.
A `paper.md` written there is uploaded to the Overleaf project for every collaborator to see, and kept in its history.

Everything fetched goes under `.research/papers/<arxiv-id>/`, versionless id, one directory per paper:

- `paper.md` — the converted text
- figures beside it, as `x1.png` and so on

Write nothing else there.
Lattice reads that directory itself; a `metadata.json` is its business, not yours.

**A paper you read is not a paper the project cites.**
Lattice's Papers list is the project's literature — what the manuscript cites or is about to — and its line is the bibliography, not the disk.
Reading thirty papers to survey a field leaves thirty directories and changes that list not at all, which is what makes a wide sweep cheap.
When one of them is actually going to be cited, hand it to `bibcite`; it then appears in Papers with its text already attached, because Lattice joins the two on the arXiv id.
Never run `bibcite` on a paper just because you read it.

## Read a paper already here

Before fetching anything, look for it:

```bash
ls .research/papers/<versionless-id>/paper.md
```

If it is there, read it.
It was either fetched by an earlier turn or imported by the user through the Papers panel, and it is the same conversion you would produce.
Refetch only when a section you need was filtered out of the copy on disk.

## Search

Run both in parallel for a topic or method phrase:

```bash
curl -sG "https://api.alphaxiv.org/search/v2/paper/full-text" \
  --data-urlencode "q=<terms>" \
  --data-urlencode "limit=10"
```

```bash
curl -s "https://api.openalex.org/works?filter=title_and_abstract.search:<terms>&per_page=20&select=id,title,publication_year,cited_by_count,ids&api_key=$OPENALEX_API_KEY"
```

Omit `&api_key=...` when `OPENALEX_API_KEY` is unset.
URL-encode query terms.
Use alphaXiv when the query is wording that lives in the body; use OpenAlex when you need lineage, citation weight, or a seed to expand.
Merge by versionless arXiv id; keep OpenAlex-only works that have no arXiv id.
Return a short ranked list (id, title, year, why it matched) — not raw JSON.
Delegate multi-paper sweeps to subagents so the main context keeps findings.

Read `references/search.md` when walking a seed's citation graph, decoding OpenAlex abstracts, handling slug/non-arXiv alphaXiv ids, or both indexes miss.

## Read

Normalize any arXiv / alphaXiv URL to an id (last path segment; strip `.pdf` / `.md`).
Classic ids look like `2401.12345` or `2401.12345v2`.

**Overview first** — cheap map of the paper:

```bash
curl -sL "https://www.alphaxiv.org/overview/<id>.md"
```

**Then `arxiv2md` for the sections the question needs** — so context stays on evidence, not the whole PDF:

```bash
mkdir -p .research/papers/<id>
uvx --from 'arxiv2markdown>=0.1,<0.2' arxiv2md <id> \
  --section-filter-mode include \
  --sections "Abstract,Introduction,Experiments" \
  -o .research/papers/<id>/paper.md
```

The version range is the one Lattice itself uses, so a paper you fetch and a paper the user imports are the same conversion.
If section titles are unknown, convert with `--remove-refs --remove-toc`, then narrow.
Do not call `https://arxiv2md.org/api/...`.
Read the file you wrote.
Numbers, equations, tables, hyperparameters, and experimental setup must come from `arxiv2md` (or a figure you opened), not from the overview alone.
If overview 404s on a classic id, go straight to `arxiv2md`.

Read `references/reading.md` for figures, slug ids, linked code, or when `arxiv2md` has no HTML.
