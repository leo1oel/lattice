---
name: related-work-openalex
description: Find related research papers, citations, references, and research lineages using an OpenAlex-based workflow. Use when the user asks for related work, literature search, citation mapping, reference chasing, prior art, seed-paper expansion, or research context around a paper or idea.
---

# Related work with OpenAlex

Map related work through the OpenAlex citation graph instead of ad-hoc web search.

## Tool

Query the OpenAlex API: an open index of ~250M works with a full citation graph, over plain HTTP.
Curl it and parse JSON; nothing to install.
Base URL: `https://api.openalex.org`.

Append `&api_key=$OPENALEX_API_KEY` to every call; if that variable is unset, omit the parameter.
URL-encode query terms (spaces as `+`).

`per_page` maxes at 100; plain paging stops at 10,000 results.

## Find candidates

Broad search across all fields:

```
curl -s "https://api.openalex.org/works?search=<terms>&per_page=20&select=id,title,publication_year,cited_by_count,ids&api_key=$OPENALEX_API_KEY"
```

Precise search over title and abstract only, much less noise:

```
curl -s "https://api.openalex.org/works?filter=title_and_abstract.search:<terms>&per_page=20&select=id,title,publication_year,cited_by_count,ids&api_key=$OPENALEX_API_KEY"
```

OpenAlex spans every field, so for niche ML terms a keyword search is noisy.
Prefer specific terms, or start from a known seed paper and walk the citation graph below.

## Map related work from a seed

Resolve a known paper to its OpenAlex id.
From an arxiv id, via the arxiv DOI (works for recent papers arxiv minted a DOI for):

```
curl -s "https://api.openalex.org/works/doi:10.48550/arXiv.<arxiv-id>?select=id,title,related_works,referenced_works,ids&api_key=$OPENALEX_API_KEY"
```

If that 404s (older paper without an arxiv DOI), find it instead with `filter=title.search:<title>`.

From the seed, three graph moves:

- `related_works`: ~10 algorithmically related papers (a field on the work).
- `referenced_works`: what the paper cites (a field on the work).
- who cites it, via the `cites:` filter:

```
curl -s "https://api.openalex.org/works?filter=cites:<W-id>&per_page=50&select=id,title,publication_year,cited_by_count&sort=cited_by_count:desc&api_key=$OPENALEX_API_KEY"
```

`related_works` and `referenced_works` come back as bare ids; expand a batch to titles with the OR filter:

```
curl -s "https://api.openalex.org/works?filter=openalex_id:W1|W2|W3&select=id,title,publication_year,cited_by_count&api_key=$OPENALEX_API_KEY"
```

Graph signals are sparse and noisy for very recent, lightly-cited papers: `related_works` drifts off-topic and `referenced_works` may be empty before OpenAlex parses the references.
They are strongest for established work, and for tracing lineage across fields.

## Abstracts

OpenAlex returns `abstract_inverted_index` (`{word: [positions]}`), not plaintext; rebuild it by placing each word at its positions.
Often the title, venue, and year are enough to triage without the abstract.

## Handoff and scale

Take each promising hit's arxiv id, from `ids.doi` in the `10.48550/arXiv.<id>` form, and read it with the `arxiv-reading` skill.
Delegate multi-paper sweeps to subagents, so the main context holds the findings rather than the raw search results.

## Fallbacks

When OpenAlex relevance is weak, which is mainly bleeding-edge ML where its keyword ranking lags and new papers are under-linked, tell the user before falling back rather than switching silently: name which fallback you are using and that its results are noisier and less complete than OpenAlex's citation graph, so they can weigh the findings accordingly. Then, in order:

1. arxiv search, or the Hugging Face paper-search tool when available, for recent ML and DL preprints.
2. The deep-research workflow for a full, cited literature survey.
3. General web search only when a paper is not in any index yet.
