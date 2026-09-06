---
name: research-writing
display-name: Research Writing
short-description: Draft and revise evidence-grounded research papers. Enable in Settings to use.
description: "Formulates, drafts, restructures, audits, and revises evidence-grounded English research papers without inventing results or citations. Use when turning experiments, figures, tables, notes, sources, or manuscripts into paper claims, outlines, abstracts, Methods, Results, Discussion, limitations, full drafts, or scientifically faithful revisions, including requests to remove generic AI-sounding prose."
---

# Research writing

Write the strongest paper the supplied evidence can support. The goal is not a
plausible paper-shaped document. It is an argument whose facts, claims, and
limits survive inspection.

Preserve the author's research choices and voice. Improve the framing when the
evidence permits it, but do not silently replace the author's scientific
priorities with your own. Venue instructions and an author-provided writing
sample outrank the stylistic defaults in this skill; neither can override the
evidence rules.

## Work in Lattice

Lattice ships this skill disabled by default; the user enables it in Settings → Skills.
Do not change skill preferences on the user's behalf to activate this workflow.

- Read the selected text and its surrounding context before editing, and follow the project's main LaTeX file and `\input` or `\include` structure rather than assuming the open file is the entire paper.
- Preserve existing macros, math environments, labels, citation keys, comments, and unrelated edits.
  Make targeted edits to the requested files instead of replacing the project with a new manuscript.
- Use the paper library's supplied paths to inspect sources.
  `.research/papers/<id>/paper.md` is cached paper text; `blog.md` is a secondary explanation, not the original paper.
  Neither a search result nor a bibliography entry proves that a paper supports a claim.
- Use Lattice's available literature and bibliography tools for adding, upgrading, or removing references.
  Never directly write `.bib` files or fabricate citation keys; use the keys returned by the tools.
- After editing LaTeX, use the available project build tools to check compilation and unresolved citations or cross-references.
  Report unavailable checks and remaining errors honestly.
- Keep audit notes out of manuscript files unless requested.
  If editing files, report the changed locations and material evidence gaps instead of duplicating the whole manuscript in chat.

## Choose the mode

- **Author-draft revision**: edit the researcher's own target-manuscript prose
  while preserving its authorship, argument, and scientific content. Use this
  when provenance or an authorship-sensitive review matters.
- **Packet to paper**: formulate a complete paper from results, notes, figures,
  sources, and other research artifacts.
- **Section drafting**: write one or more sections while maintaining the whole
  paper's claim and terminology ledgers.
- **Restructure**: repair the argument or section order of an existing draft.
- **Revision**: improve accuracy, scope, clarity, and prose without changing the
  research record.
- **Audit**: report unsupported claims, missing evidence, structural failures,
  and generic model prose before changing text.

For ordinary paper authoring, read these references as their phase becomes
relevant rather than loading all of them at once:

1. `references/evidence-and-claims.md` before formulating claims.
2. `references/paper-architecture.md` before outlining or drafting sections.
3. `references/revision-and-style.md` before drafting or revising prose.
4. `references/research-judgment.md` only when the task also asks for research
   framing, experiment critique, or a choice among defensible paper stories.

## Return the requested artifact

Put the user's requested manuscript, section, revision, outline, or audit first.
Keep private evidence ledgers and diagnostic labels out of manuscript prose
unless the user asks to see them.

- For drafting, return manuscript-ready prose followed only by unresolved
  evidence gaps that materially limit it.
- For revision, return the revised text first. Add a concise change record when
  the user requests one, a change affects a claim, or provenance-sensitive
  author-draft revision makes generated material or altered certainty relevant.
- For audit, report findings with locations, evidence consequences, and the
  smallest safe repair. Do not silently rewrite unless the user also asks for a
  revision.
- For a blocked task, use the evidence-gap format below instead of producing a
  plausible completion.

## Start with an evidence gate

Normalize the supplied material into four categories before writing:

- direct observations and results;
- the author's interpretations;
- claims about prior work, each with a source;
- assumptions, open questions, and missing evidence.

Then build a claim-evidence ledger using the contract in
`references/evidence-and-claims.md`. A complete paper normally has one to three
umbrella claims. This is a default, not a quota. Each claim needs a precise
scope, supporting evidence, live alternatives, and evidence that would falsify
or weaken it.

Keep two working layers. The private audit layer contains source locators,
evidence and claim IDs, statuses, wording ceilings, and unresolved gaps. The
prose-facing research record contains the scientific objects, methods,
equations, settings, values, citations, negative results, and limits, without
the audit vocabulary or a prewritten narrative. Draft from the research record;
verify against the audit layer. Do not make a reader follow the evidence-control
system used to keep the paper accurate.

Stop when any missing item would change a central conclusion, comparison,
causal interpretation, or citation. Return this instead of filling the gap:

```text
Status: BLOCKED

Available evidence:
- ...

Evidence gaps:
| Gap | Claim or section blocked | Why inference is unsafe | Minimum input needed |

Safe work possible now:
- evidence ledger entries that are already supported
- provisional claim candidates marked untested
- a non-narrative outline with explicit gaps
```

If the gaps are local and non-blocking, continue with a working draft and mark
them as `[EVIDENCE GAP: ...]`. Never make the prose sound final while its
central evidence is provisional.

## Preserve provenance in author-draft revision

An author-provided style sample and an author-written target draft are different
inputs. Another researcher's published paper may inform general writing
judgment, but it cannot supply authorship for a new manuscript. Use this mode
only when the researcher supplies prose they wrote for the target work and has
authorized its revision.

Before editing:

1. freeze the original draft and record its hash;
2. extract its claims, comparisons, numbers, units, citations, quotations,
   equations, tables, named entities, uncertainty, and limitations;
3. identify requested changes and passages that are already correct;
4. mark missing sections or arguments that would require new prose.

When the original and revised drafts are available as files, run
`uv run --no-project python <skill-directory>/scripts/audit_revision.py ORIGINAL REVISED` after the prose pass, resolving the script relative to this skill's installed directory.
If the Python runner is unavailable, perform the comparison manually and report that the script was not run; do not install dependencies without permission.
Treat its protected-span differences as review signals, not automatic errors.
A `PASS` only means the script found no differences in the spans it recognizes; it can miss unit changes, reassigned citations, and some LaTeX math.
The bidirectional semantic audit below remains required.

Edit the smallest unit that solves a real scientific or reader problem. Preserve
the author's section and paragraph architecture, terminology, and sentence
choices unless one of them causes that problem. Do not rewrite a correct
paragraph merely to regularize style. Protect evidence-bearing spans during a
prose pass and restore them exactly unless the evidence audit authorizes a
change.

Keep a revision ledger with each changed span classified as `correction`,
`clarification`, `restructure`, or `generated`. If a missing passage must be
written from the research record, disclose it as generated instead of blending
it into the author-written draft. When provenance is the acceptance criterion,
return the gap and ask the author to draft it before editing.

Finish with two independent walks: map every original claim and qualification
into the revision, then map every revised factual statement back to the original
draft or research record. Report dropped claims, new claims, altered certainty,
and generated spans. Writing in the statistical style of human papers does not
change generated prose into human-authored prose.

## Formulate the paper

### 1. Establish the reader and paper type

Identify the expert reader, venue constraints, contribution type, and the
decision or understanding the paper should change. Distinguish method papers,
empirical findings, theory, systems, datasets, replications, negative results,
surveys, and position papers. Do not force all of them into one narrative.

### 2. Find the defensible story

Look for the actual relation among problem, evidence, and contribution. A useful
story may turn on an observed contradiction, an under-constrained problem, a
testable hypothesis, a unifying representation, a failure taxonomy, or a
boundary exposed by negative evidence. Use a tension only when the research
record contains it. Do not manufacture drama around an ordinary improvement.

When two materially different stories are defensible, show their claims,
evidence, and tradeoffs and ask the author to choose. In an explicitly
autonomous run, choose the story with the strongest evidence coverage and
record the rejected alternative in the working notes.

### 3. Build the argument before prose

Create:

- the claim-evidence ledger;
- a claim dependency graph;
- a terminology and notation ledger;
- a prose-facing research record that removes IDs, statuses, wording ceilings,
  and drafting advice while preserving every conclusion-changing fact;
- an outline in which every section answers a reader question;
- a figure and table plan in which every item supports a claim;
- a working abstract used to expose missing logic, not as final copy.

Each outline unit must name its claim IDs, evidence IDs, strongest alternative,
and boundary. Delete a section that serves no claim or reader need.

Privately distinguish evidence by its role: explanatory evidence makes the
scientific object intelligible; decisive evidence most directly changes the
central claim; corroborating evidence tests recurrence or breadth; boundary
evidence changes how a result must be read. These roles are not manuscript
labels. Develop explanatory and decisive evidence, combine corroborating tests
by the question they answer, and place a boundary beside the inference it
changes.

### 4. Draft evidence-bearing sections first

Draft Methods and Results before polishing the Introduction. This forces the
paper's promises to match the work that was actually done. For each result,
state the question, setup, comparison, observation, interpretation, and limit.
Tell the reader which value, line, point, or qualitative case carries the
conclusion. Report losses, null results, and metric disagreements beside the
wins they qualify.

Draft each paragraph around one scientific pressure point: the observation,
failure, comparison, derivation, or decision the reader must understand next.
Give unequal findings unequal space, and do not force neighboring concepts into
matched clauses or a miniature-paper template. Use
`references/revision-and-style.md` for the paragraph and sentence passes.

### 5. Draft the remaining sections

Use `references/paper-architecture.md` for section contracts. Related Work
compares assumptions, mechanisms, or evidence, rather than summarizing papers
one at a time. Discussion distinguishes observation, interpretation, and
speculation. Limitations state which claim each limitation narrows and what
evidence would resolve it.

### 6. Run an argument-hierarchy pass

Before polishing, write down the paper's central answer, the decisive test that
supports it, and the single boundary that most changes how it should be read.
Use those three items to revise the whole draft:

- let the Introduction connect the concrete problem or question to the central
  answer or contribution and its decisive evidence; the exact order follows the
  paper type, but the full inventory of controls and secondary analyses belongs
  in Methods or Results;
- map every occurrence of each major claim boundary. Preserve the first
  necessary local qualification and one section-appropriate synthesis; keep any
  later occurrence only when it adds a distinct consequence, alternative, or
  test;
- after reporting a result, explain only the next non-obvious inference; do not
  paraphrase a measurement and then enumerate every claim it excludes;
- classify every experiment as a central test, mechanism probe, robustness
  check, or practical boundary. Report all of them, but reserve repeated
  cross-section emphasis for the central test and the most claim-changing
  boundary;
- organize Discussion around the inferences that several results jointly
  support, not around another walk through the Results section.
- after provenance is verified, write about the study rather than the packet:
  state which experiment or comparator exists or is missing, and mention how
  evidence was supplied only when its provenance affects validity or
  reproducibility.

This pass changes rhetorical prominence, never the research record. It must not
remove mixed or negative evidence, detach a necessary qualifier from its claim,
or make a section falsely self-contained by repeating the entire audit trail.

### 7. Rewrite the final abstract and title

After the evidence-bearing sections stabilize, rewrite the abstract from
scratch. State the achievement, the precise problem or difficulty, the
approach, the strongest evidence including a number when one is central, and
the relevant boundary. Set the title last. It should identify the subject and
real distinction without claiming more than the paper proves.

### 8. Run global audits

Audit in this order:

1. provenance of every fact, number, quotation, and citation;
2. support and scope of every empirical or theoretical claim;
3. separation of observation, interpretation, and speculation;
4. agreement among title, abstract, introduction, results, and conclusion;
5. terminology, notation, metrics, populations, and comparison directions;
6. figure, table, caption, and cross-reference integrity;
7. reader comprehension and prose;
8. venue and formatting requirements.

Correctness audits precede style. A style pass may not change a number,
citation, claim polarity, causal strength, population, or uncertainty without
returning to the evidence ledger.

## Non-negotiable invariants

1. Do not invent facts, results, citations, quotations, methods, experiments,
   or a discovery history.
2. Every central claim must be falsifiable, scoped, and linked to evidence.
3. Untested claims remain questions or hypotheses, never abstract or conclusion
   findings.
4. Causal language requires causal evidence. Association is not intervention.
5. Negative, mixed, and failed results cannot disappear for narrative ease.
6. Prior work must be represented from sources, not titles, metadata, or memory
   alone.
7. Technical terms do not change merely to avoid repetition.
8. Figures and tables are evidence, not decoration; the prose also states the
   decisive comparison.
9. Missing evidence stays visible. Fluency is never a substitute for support.
10. Style rules are heuristics. Scientific meaning, author voice, and venue
    conventions take priority over punctuation, sentence-length, or vocabulary
    preferences.
