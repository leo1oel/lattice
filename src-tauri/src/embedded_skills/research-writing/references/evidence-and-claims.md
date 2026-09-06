# Evidence and claims

This file defines the private working artifacts behind a defensible paper. Do
not paste the full ledgers into the manuscript unless the user asks for them.

## Normalize the research packet

Assign a stable ID to every source and evidence item. Keep literal observation
separate from interpretation.

```text
Source
S-id | artifact | author or provenance | exact locator | access status

Evidence
E-id | literal observation | source locator | setup and comparator
     | value and uncertainty | known limitation

Claim
C-id | exact falsifiable wording | scope and conditions | status
     | falsifier | supporting evidence IDs | counterevidence
     | live alternatives | section or figure destination | wording ceiling
```

Use these claim statuses:

- `supported`: the supplied evidence directly supports the scoped wording;
- `mixed`: support changes by metric, population, condition, or replicate;
- `contradicted`: the supplied evidence weighs against it;
- `untested`: plausible, but not tested by the supplied record.

The wording ceiling is the strongest sentence the evidence permits. For
example, an observation in two image-classification datasets may support
"improved accuracy on the two evaluated datasets" but not "generalizes across
vision tasks."

## Evidence gate

A central claim is ready only when all of the following are known:

- the intervention, system, population, or object being studied;
- the comparator or counterfactual, where the claim requires one;
- the metric and whether higher or lower is better;
- the experimental or theoretical conditions;
- the relevant value, uncertainty, or qualitative observation;
- the strongest live alternative explanation;
- the boundary beyond which the result has not been tested.

Missing details are blocking when they could change the claim's direction,
magnitude, novelty, cause, or scope. Missing cosmetic or implementation detail
may be deferred to an explicit gap.

## Claims and evidence

### Make claims testable

Replace themes with statements that could be wrong. "Understanding model
behavior" is a topic. "Intervention A changes behavior B under condition C" is
a claim if A, B, and C are operationally defined.

Record what evidence would count against each claim. If no possible observation
could weaken it, the statement is framing or opinion, not a research finding.

### Keep inference levels separate

Use three levels:

1. **Observation**: what was measured, proved, or seen.
2. **Interpretation**: the explanation best supported by those observations.
3. **Speculation**: an untested implication or proposed mechanism.

Signal movement between levels. A result can be strong while its mechanism
remains uncertain.

Do not turn:

- correlation into causation;
- benchmark performance into general capability;
- absence of evidence into evidence of absence;
- a toy model into a statement about the full system;
- one qualitative example into prevalence;
- a non-significant result into equivalence;
- a metric improvement into practical importance without the needed context.
- simultaneous worsening of training and held-out error into overfitting; that
  label needs evidence that training fit improved relative to the comparator
  while held-out behavior worsened, or another direct train–test gap analysis;
- failure to recover at one finite training or compute extension into proof that
  budget is irrelevant; state which tested extension failed and leave larger or
  different optimization procedures unresolved.

### Treat disagreement as evidence

When metrics, datasets, replicates, or qualitative and quantitative evidence
disagree, preserve the disagreement. Ask what each measurement captures and
which claim it can support. Do not average away a contradiction or quote only
the favorable metric.

### Pair gains with boundaries

Report a result together with the condition under which it holds. Place a
failure case near the claim it limits, not only in a late disclaimer section.
For each limitation, state:

1. what is missing or confounded;
2. which claim becomes narrower because of it;
3. what experiment, proof, or source would resolve it.

## Numbers

For every reported number, record:

```text
N-id | value | unit | denominator or population | statistic
     | uncertainty | direction | evidence ID | derived formula, if any
```

Keep absolute and relative changes distinct. State the baseline behind a
percentage improvement. Do not add significance language when no statistical
test is supplied. A derived number must include its formula and inputs; never
present it as directly measured.

Check every number in the abstract, introduction, figure captions, results, and
conclusion against the ledger after the final style pass.

## Citations and prior work

Metadata proves identity, not content. Read the source before using it to
support a substantive statement. Associate each prior-work claim with an exact
source locator when the tools permit it.

Separate these jobs:

- crediting an idea or artifact;
- supporting an empirical or theoretical statement;
- positioning the present contribution;
- pointing readers to background.

A citation can perform more than one job, but the prose must make the job clear.
Never cite a source for a stronger claim than the inspected passage supports.
Do not infer a paper's findings from its title or abstract when the body is
needed.

Related Work should compare families along explicit axes such as assumptions,
supervision, scale, intervention, guarantees, or evaluation coverage. Drafting
paper-by-paper notes is fine; the manuscript should synthesize them.

## Claim graph

Record relations among claims, not only a flat list:

```text
C1 --supported by--> E1, E2
C2 --depends on--> C1
E3 --limits--> C1
A1 --alternative to--> C2
C3 --untested extension of--> C1
```

The graph should reveal whether removing one result collapses the main
conclusion. It should also reveal decorative experiments that support no claim.

## Separate audit scaffolding from writer-facing material

The source and claim ledgers are private control artifacts. Before prose
drafting, derive a writer-facing research record containing only the scientific
material: definitions, assumptions, methods, equations, settings, values,
uncertainty, citations, negative or mixed results, and open alternatives.
Remove IDs, statuses, wording ceilings, importance labels, audit verdicts, and
drafting instructions. Do not remove a limit merely because it originated in a
claim ceiling.

The research record is neither an outline nor a manuscript. Prefer terse notes,
tables, equations, and source-attached facts over polished transitions. Its
grouping should make the scientific objects inspectable without prescribing a
paper-shaped sequence. Draft from this record, then audit the resulting prose
against the private ledgers. This separation prevents evidence-management
language from becoming the topic of the paper without weakening provenance.

## Outline contract

For each proposed section or subsection, record:

```text
Reader question
Section answer
Claim IDs
Evidence IDs
Figure or table role
Strongest objection or alternative
Boundary or explicit non-claim
Dependency on the previous section
```

Do not draft a section until its answer and evidence are known. Do not retain a
section because papers of this genre usually have one.

## Final provenance audit

Extract claims from the finished prose rather than trusting the planning
ledger. Check every factual assertion, number, citation, and comparison. Mark
any statement that cannot be mapped back to the research packet. Then either
remove it, weaken it to the supported wording, or request the missing source.
