# Reading details

Load this for figures, non-arXiv alphaXiv ids, linked code, or when `arxiv2md` cannot convert the paper.

Everything fetched goes under `.research/papers/<versionless-id>/`, never the project root — see the skill body for why.

## Overview and slug ids

```bash
curl -sL "https://www.alphaxiv.org/overview/<id>.md"
```

Classic-id overview 404 means the report is not ready — continue with `arxiv2md`.
Slug id: do not run `arxiv2md`. Use extracted text and/or the source:

```bash
curl -sL "https://www.alphaxiv.org/abs/<id>.md"
curl -sL "https://api.alphaxiv.org/papers/v3/<id>"
```

`abs/<id>.md` is a last-resort prose dump when `arxiv2md` and ar5iv both fail on a real arXiv paper.
A slug id is not an arXiv paper, so it has no `.research/papers/` directory — keep what you read in context rather than writing it anywhere.

## arxiv2md

```bash
mkdir -p .research/papers/<id>
uvx --from 'arxiv2markdown>=0.1,<0.2' arxiv2md <id> \
  --section-filter-mode include \
  --sections "Abstract,Method,Experiments" \
  -o .research/papers/<id>/paper.md
```

Unknown section titles:

```bash
uvx --from 'arxiv2markdown>=0.1,<0.2' arxiv2md <id> --remove-refs --remove-toc \
  -o .research/papers/<id>/paper.md
```

Flags: `--section-filter-mode include|exclude`, `--sections "A,B,C"`, `--remove-refs`, `--remove-toc`, `-o <path>`.
Do not use `-o -` here; the point is that the text lands where Lattice and later turns can find it.
Do not call `https://arxiv2md.org/api/...`.
Read the file you wrote. Widen the section list only when a needed detail is missing.

## Figures

`arxiv2md` leaves figures as inert names like `Refer to caption: x1.png`.
Resolve against the paper's HTML directory (versionless id), download **into the paper's own directory**, then Read:

```bash
curl -sL "https://arxiv.org/html/<id>/x1.png" -o .research/papers/<id>/x1.png
```

If the caption already includes a directory prefix, use that path under `https://arxiv.org/html/` instead.
Fetch one figure at a time.

A figure that belongs in the manuscript is a different thing: import it through Lattice so it lands in `figures/` and is version-tracked with the paper.

## Linked code

When implementation details matter and a GitHub URL is attached to the paper, shallow-clone into a temp directory outside the project — `mktemp -d` — and inspect configs / entrypoints there.
A clone under the project root would be committed to version history and uploaded to Overleaf.
Confirm the repo matches the paper before treating it as ground truth.

## Fallback when there is no arXiv HTML

1. WebFetch `https://ar5iv.org/abs/<id>` with a specific question.
2. alphaXiv `abs/<id>.md` if present.
3. PDF via Read on a page range — last resort, not a full dump.
