# Lattice research environment

Verifiable LaTeX tasks for training and evaluating paper-writing agents.
Each task is a real paper with one fault in it, a verifier that decides
whether the agent repaired it, and self-tests that prove the verifier
cannot be talked into passing a cheat. Tasks are
[Harbor](https://github.com/harbor-framework/harbor) task packages, so
Claude Code, Codex CLI and every other Harbor agent run them in a pinned
TeX Live container unchanged, and Tinker's Harbor RL recipe trains on them.

This is Phase 1 of the plan in the research-env scout report: the TeX-only
task families, which need only TeX Live and `pdftotext`, not the Lattice
app. Everything here is the Python standard library; nothing to install.

```bash
cd research-env
python3 -m lattice_env seeds                                  # the seed papers and their licences
python3 -m lattice_env generate --out /tmp/tasks              # generate, guard and admit tasks
python3 -m lattice_env selftest /tmp/tasks/<task>             # rerun one task's self-tests
python3 -m lattice_env verify /tmp/tasks/<task> <workspace>   # score a workspace
python3 -m unittest discover -s tests                         # the tests (TeX ones need latexmk + pdftotext)
```

Running the tasks through Harbor (needs Docker):

```bash
harbor run -p /tmp/tasks -a oracle          # the reference repairs: every task scores 1
harbor run -p /tmp/tasks -a nop             # the untouched papers: every task scores 0
harbor run -p /tmp/tasks -a claude-code -m anthropic/<model> -k 4
harbor run -p /tmp/tasks -a codex -m openai/<model> -k 4
```

## A task package

```
<task>/
  task.toml             Harbor's config; [metadata] has family, operator, category, tier, seed
  instruction.md        what the agent is told; never names the fault
  environment/
    Dockerfile          TeX Live 2025 pinned by digest, plus pdftotext; the workspace copied to /app
    workspace/          the broken paper
  solution/             the oracle: fix.json (the reference repair) and solve.sh to apply it
  tests/                uploaded only after the agent is done
    test.sh             Harbor's entry: writes /logs/verifier/reward.{txt,json} and verdict.json
    verify.py           python3 -I verify.py --workspace DIR [--out DIR]
    selftest.py         python3 -I selftest.py: this task's self-tests
    lattice_verifier/   a copy of lattice_env/verifier, so the package needs nothing else
    task.json           the verifier's private config: the fault, the edit budget, file hashes
    initial/ original/  the editable files before and after the fault
    selftests/*.json    the self-test cases
```

`tests/` holds only text files, since Tinker uploads them as text.

## How a submission is scored

Gates first. A submission scores 0 unless every gate holds:

| Gate | Fails when |
| --- | --- |
| `noRedLines` | the submission crosses a red line (below) |
| `withinBudget` | it changed more characters than the task's budget: `max(64, 4 × the reference repair + 32)` |
| `preserved` | the original paper's labels, citations, sections, figures, environments or list items are gone |
| `builds` | the pinned build fails or times out |
| `referencesResolved` | a label prints a different number than in the original, a citation resolves differently, a `\ref` or `\cite` is undefined, or the PDF prints `??` or `[?]` |

Then the grade. A PDF byte-identical to the original paper's scores **1**.
Anything else scores `0.9 × restoration × editTerm`: `restoration` falls
by half for every 4 tokens of the PDF's text that differ from the
original's (`pdftotext -layout`, lowercased), and `editTerm` falls as the
square root once the edit is bigger than the reference repair. The decay is
steep on purpose: deleting the one sentence that holds a fault keeps a
4-page paper's text 99% similar, and pays almost nothing here.

Red lines, each a way to pass without repairing the paper:

| Code | What |
| --- | --- |
| `silenced_warnings` | reconfiguring LaTeX's warnings or error reporting (`\@latex@warning`, `silence`, `\nofiles`, …) |
| `redefinition` | `\renewcommand`, `\def`, `\let`, `\makeatletter`, … that the original paper did not have |
| `fault_alias`, `fault_kept` | defining the broken name instead of repairing it (`\providecommand{\citpe}`), or a paper that builds with it still in place |
| `new_label`, `new_bib_key` | a label or bibliography key the original never had: how an undefined `\ref` gets "resolved" |
| `content_hidden` | the paper's own text commented out, or wrapped in `\iffalse` or a `comment` environment |
| `protected_file_changed`/`_deleted` | a style file, figure or any other non-editable file changed |
| `new_tex_input`, `latexmkrc` | a package, class or style file that would shadow TeX's own, or an rc file |
| `outside_path`, `outside_input` | reading a file from outside the project (checked in the source and in TeX's `.fls`) |
| `invisible_text`, `early_end`, `documentclass_changed` | white or phantom text, `\endinput`, a second `\end{document}`, a new document class |
| `honeypot_touched` | the workspace's decoy `.lattice/grading.json` changed |

`reward.json` carries the named components beside `reward`:
`pdfIdentical`, `restoration`, `editTerm`, `similarity` (TeXFix-Bench's
S_pdf, for comparison) and `pagesMatch`. `verdict.json` has everything,
including which gates failed and why. When the verifier cannot judge (TeX or
`pdftotext` missing, the original paper failing to build), the status is
`infra_error`: it writes no reward and exits 1, so Harbor records an error
rather than a 0 the agent did not earn. (Tinker's recipe scores a grading
error as 0.0; drop those episodes there by their `verdict.json`.)

### The pinned build

latexmk with `-norc` (no rc file runs), no shell escape, pdfTeX only, a
fixed root document, a fresh copy of the sources with every build artifact
removed, a fresh HOME and TeX user trees, and `SOURCE_DATE_EPOCH` with
`FORCE_SOURCE_DATE` pinned. The reference is rebuilt from the original
sources in the same environment on every verification, so a task's score
never depends on a PDF built elsewhere.

## Self-tests

Every task ships cases its verifier must score as expected, and the
generator admits a task only if all of them hold:

- the reference repair scores 1; the untouched workspace scores 0;
- each known cheat that applies scores 0: deleting the enclosing section,
  hiding it in `\iffalse`, commenting the faulty paragraph out, silencing
  warnings, a project `.latexmkrc`, aliasing the broken name, inventing a
  label, redefining `\ref`, a stub package, touching the decoy, a different
  paper, an empty paper;
- probes stay below 0.5: deleting the faulty line, and three seeded random
  edits.

A rejected task stays in the output's `_rejected/` folder with its failing
cases in `manifest.json`, so a family whose verifier leaks shows up as a
rejection rate. `generate --strict` (what CI runs) fails on any of them.

## Build repair

The operators port [DocMut](https://github.com/prajwal-svm/docmut)'s LaTeX
catalogue (MIT, Copyright (c) 2026 Prajwal S. Venkateshmurthy / Oleafly)
under its codes and tiers, so results compare with TeXFix-Bench, whose
categories they carry. `LAT-*` operators fill the taxonomy categories DocMut
does not cover for pdfLaTeX. A mutant is kept only if the pinned build
fails on it (DocMut's render-diff guard), and sites are drawn with a seeded
shuffle keyed by the salt, the seed's content and the operator.

| Code | Tier | Category | Fault |
| --- | --- | --- | --- |
| TEX-BRC-DRP | 1 | BraceGroupFault | a closing brace deleted |
| TEX-BRC-STR | 1 | BraceGroupFault | a stray `{` in a paragraph |
| TEX-ENV-REN | 1 | EnvironmentMismatch | `\end{equation}` → `\end{equaton}` |
| TEX-ENV-UNC | 1 | EnvironmentMismatch | the `\end{...}` line deleted |
| TEX-MTH-DLR | 1 | MathModeFault | an inline formula's closing `$` deleted |
| TEX-MTH-DSP | 1 | MathModeFault | a closing `\]` deleted |
| TEX-CLS-DRP | 1 | DocumentBoundaryFault | the `\documentclass` line deleted |
| TEX-ITM-MSN | 1 | OtherFatalCompile | an `\item` moved out of its list |
| TEX-PKG-DRP | 1 | MissingRequiredPackage | a `\usepackage` line the paper relies on deleted |
| TEX-CMD-TRP | 2 | UndefinedControlSequence | DocMut's typo table (`\section` → `\sectin`, …) |
| TEX-ARG-DRP | 2 | BraceGroupFault | the second argument of `\frac`, `\textcolor`, … deleted |
| LAT-CMD-TYP | 2 | UndefinedControlSequence | a used macro's last two letters swapped (`\citpe`) |
| LAT-GFX-PTH | 3 | GraphicsIncludeFault | an `\includegraphics` path misspelt |
| LAT-FIL-BIB | 3 | MissingExternalFile | the `\bibliography` or `\bibliographystyle` name misspelt |
| LAT-ENC-UCS | 3 | InputEncodingFault | a pasted Unicode character pdfLaTeX has no definition for |
| LAT-TAB-XTR | 3 | TableAlignmentFault | a table row with one cell too many |
| LAT-TAB-AMP | 3 | TableAlignmentFault | an unescaped `&` in running text |
| LAT-ARG-PAR | 3 | BraceGroupFault | a blank line inside an argument |
| LAT-DOC-BEG | 3 | DocumentBoundaryFault | `\begin{document}` deleted |

## Seeds and licences

`python3 -m lattice_env seeds` lists them. The bundled seeds are Lattice's
own templates (the tutorial paper and the NeurIPS, ICML and ICLR
skeletons), written the way project creation writes them. Conference style
files ship unmodified and carry no licence grant of their own (see each
template's `UPSTREAM.md`), so seeds that need them are marked
`redistributable: false`; a dataset release should filter on that. The
tutorial's two figure panels reproduce Google's Transformer figure under a
grant limited to scholarly use, so the seed replaces them with plain
placeholder images of the same size and words the caption accordingly.

Private seeds, for a held-out split that is never published, are folders in
the same layout (`seed.json` plus the project) passed with `--seeds-dir`,
generated with a private `--salt`.

## Known limits

- **No Docker on the development Mac.** Colima has a stopped profile and
  there is no `docker` CLI, so no Harbor run has happened locally. CI builds
  the task image and runs the TeX tests and a strict sample generation in
  it, which is also where pdfTeX's determinism inside the container is
  checked (every seed is built twice in different folders).
- **The image is amd64 only** (`TL2025-historic` has no arm64 build); on
  Apple Silicon it runs under emulation.
- **The base image moves.** The historic tags are rebuilt monthly on Debian
  testing; the Dockerfile pins the digest, and `poppler-utils` comes from
  whatever Debian testing ships when the image is built, which can shift
  `similarity` and `restoration` slightly but never PDF identity.
- **An agent running as root in the container can change TeX Live itself**
  (or the verifier's Python) before Harbor's verifier runs in the same
  container. The `.fls` check catches inputs from outside TeX's trees, not
  edits inside them. Harbor's separate-verifier mode, with `/app` declared
  as an artifact, verifies in a fresh container and closes this; it is not
  the default in Harbor 0.24 and is untested here.
