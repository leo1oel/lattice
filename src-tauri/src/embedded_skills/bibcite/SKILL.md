---
name: bibcite
description: Manage paper citations and .bib files through the cite tool and the bibcite CLI instead of hand-editing them. Use whenever a task involves adding a paper reference or \cite, resolving an arXiv ID, arXiv DOI, DOI, URL, or title to BibTeX, cleaning or checking a bibliography, deduplicating entries, or upgrading arXiv preprints to published records.
compatibility: Runs inside a Lattice project. Requires network access for paper resolution; the maintenance commands need bibcite or uv.
---

# bibcite

Route every `.bib` change through a tool, never through the file. Editing it
directly is blocked, and for good reason: resolving metadata, canonicalizing
venues, deduplicating, preserving existing citation keys and formatting all
have to happen together.

## Adding a reference: the `cite` tool

**To add anything the project will cite, call the `cite` tool.** One argument —
an arXiv id or URL, a DOI, a web page URL, or the paper's title — and it
returns the citation key.

It is the same path the user's own Papers box uses, which is why it is the one
to reach for: besides the `.bib` entry, it fetches the paper's full text and
overview into `.research/papers/<arxiv-id>/`, records the change as something
the user can undo, and makes the work appear in their Papers list. Running
`bibcite add` by hand writes the entry and none of the rest, leaving a citation
whose text nobody can open.

**Reading a paper is not a reason to call it.** Surveying a field means reading
many papers and citing few; see `find-and-read-papers` for reading. Call `cite`
when a work is going into the manuscript.

Use the exact key it returns in `\cite{...}` — do not invent or reformat it.

## Maintaining a bibliography: the CLI

For everything that is not "add one reference" — checking, tidying,
deduplicating, upgrading preprints to their published versions — use the
commands below. They read and rewrite an existing file rather than resolving
something new, so they need no fetch and no Papers entry.

## Choose the command

```bash
bibcite add refs.bib <arXiv ID | arXiv URL | arXiv DOI | DOI | web page URL | title>
bibcite add refs.bib --bibtex '<complete BibTeX entry>'
bibcite add refs.bib --from queries.txt
bibcite add refs.bib <query> --replace
bibcite add refs.bib <query> --key existingKey
bibcite remove refs.bib <key>
bibcite get <query> [--json]
bibcite upgrade refs.bib [--dry-run]
bibcite check refs.bib
bibcite tidy refs.bib
bibcite fix refs.bib
```

Use `get` only to preview a paper without changing a bibliography.
Prefer the `cite` tool over `add` for a single new reference; `add` is for the
cases `cite` does not cover — a complete BibTeX entry you already hold, a batch
from a file, or replacing a specific existing key.
Use `--from` for multiple papers because one process shares source throttling state and tidies the file once.
Use `--replace` only when the resolved paper should overwrite an automatically matched entry.
Use `--key` when title drift prevents automatic matching and a specific existing citation key must be replaced.
Use `upgrade --dry-run` before upgrading a large bibliography.
Use `fix` when the user asks to clean up a bibliography end to end.

## Use the returned citation key

File-changing commands print a JSON result on standard output and diagnostics on standard error.
Read the `key` from JSON after `add` and use that exact value in `\cite{...}` instead of guessing or reconstructing it.
After a write, confirm that `tidied` is `true` before reporting that formatting completed.
An `exists` result may have `tidied` set to `false` because the file was unchanged, so `add` skipped the formatting pass.
For any other `tidied: false` result, expect exit code `1` and retry once with `bibcite tidy <file>`.
`bibcite` downloads `bibtex-tidy` through `npx`, so do not install it separately.
If Node.js or `npx` is missing, ask before installing it and never format the file by hand.

Treat these `action` values as successful outcomes:

- `added` means a new entry was written.
- `exists` means the paper was already present and no duplicate was added.
- `upgraded` means a preprint was replaced by its published record while keeping the existing key.
- `replaced` means an explicitly targeted entry was overwritten while keeping its existing key.

For batch commands, inspect every item in `results` because one failed query does not invalidate successful entries.

## Handle publication uncertainty

An unmatched upgrade reports either `no_published_version` or `sources_unavailable`.
Treat `no_published_version` as a trustworthy miss.
Treat `sources_unavailable` as temporary because rate limits or outages prevented a complete check, so retry later without writing a replacement by hand.

A preprint result may include `published_check`.
Treat `complete` as a trustworthy publication check and `incomplete` as a reason to retry later.

An entry that is intentionally preprint-only can use `pubstate = {preprint}` to mute future `check` and `upgrade` warnings.
Submit the complete updated entry through `--bibtex` and target its existing key rather than editing the file directly.

## Handle exit codes

- Exit code `0` means the command completed successfully.
- Exit code `1` means a file, lint, or formatting problem remains.
  Inspect `problems`, `remaining_problems`, and `tidied` before deciding what to do next.
- Exit code `2` means the paper or requested entry was not found.
  Ask for a stronger identifier, preferably an arXiv ID or DOI, instead of fabricating an entry.
- Exit code `3` means publication sources or an internal tool failed.
  Retry later and never fall back to hand-editing the bibliography.

`check` is read-only, but it returns exit code `1` when it finds problems.
`fix` also returns exit code `1` when unresolved lint issues remain or formatting fails.
