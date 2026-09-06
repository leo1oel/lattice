# Paper architecture

Architecture follows the research contribution. The contracts below describe
what readers need, not a mandatory section count or order.

## Choose a narrative that the evidence contains

Common research narratives include:

- an observed contradiction followed by a reframing that resolves it;
- an under-constrained problem made tractable by one justified constraint;
- a precise, falsifiable hypothesis tested by progressively stronger controls;
- a unified representation that turns disparate methods into comparable cases;
- a taxonomy that makes recurring system failures inspectable;
- a toy model that isolates a mechanism and states the boundary to real systems;
- a negative result that rules out a plausible direction;
- a resource or system whose value is demonstrated by use and coverage.

These are diagnostic possibilities, not templates. Use one only when the
packet supplies its tension and evidence. An ordinary measured improvement may
need a straightforward comparison rather than a dramatic story.

## Title

Set a provisional title during outlining and the final title after the paper is
stable. Name the object of study and the real distinction or result. Avoid
unscoped superlatives, slogans, and claims of universality. A memorable name is
useful only when it describes a real property and does not conceal the method.

## Abstract

A reader should learn:

- what the paper establishes or introduces;
- which precise problem, limitation, or question makes that contribution
  necessary;
- the shape of the approach;
- the strongest evidence, including the decisive number when one exists;
- the main scope boundary when omission would invite over-reading.

This is a coverage test, not a five-sentence form. Lead with information. Do not
open with a generic claim that the field is important. Do not tease the result
by withholding the number or core mechanism. Rewrite the final abstract after
the body is stable.

## Introduction

Move quickly from the concrete research problem to the contribution. An expert
reader should understand, early:

1. what was achieved and why the unresolved problem is real;
2. why the closest existing approach or framing does not settle it;
3. what the present work does differently;
4. what evidence supports the claims and what evidence is absent;
5. the paper's actual contributions and boundaries.

The introduction may begin with an anomalous result, a concrete use case, a
precise question, or the contribution itself. It should not begin with a
paragraph that could prefix any paper in the field.

Contribution bullets are optional. Use them when they improve scanning, not to
force every contribution into a matching grammatical shape or an arbitrary
count.

## Background and problem setting

Include background only when an intended reader needs it, it is not new to this
paper, and the contribution cannot be understood without it. Move textbook
formalism and exhaustive detail to an appendix when venue conventions allow.

Define ambiguous concepts operationally. State the task, variables, and
evaluation target before asking the reader to assess a solution.

## Related work

Organize by the distinctions that matter to the present claim: assumptions,
mechanisms, supervision, guarantees, scale, data, or evaluation. Compare and
contrast. Credit sources fairly and avoid turning the section into a list of
mini-abstracts.

State prior limitations narrowly. "Does not evaluate condition C" is different
from "cannot handle C." Never weaken prior work to make the current paper look
necessary.

## Method

Give a reader enough information to understand what was done, why each design
choice belongs, and how the evidence could be reproduced or assessed. Depending
on the contribution, cover:

- data and inclusion rules;
- model, intervention, algorithm, system, or proof setup;
- controls, baselines, and held-fixed variables;
- metrics and their direction;
- training, sampling, measurement, or analysis protocol;
- uncertainty and statistical procedure;
- implementation choices that affect interpretation.

Present the final method as a coherent object. Include discovery history only
when it explains an otherwise arbitrary choice, and only when that history is
present in the research record. Do not invent a noticed-hypothesized-tested
story after the fact.

## Results

Organize results by reader questions or claims, not experiment chronology. Each
result unit should contain:

1. the question or claim under test;
2. the relevant setup and comparator;
3. the exact observation, including uncertainty when supplied;
4. the figure, table, line, point, or example that carries it;
5. the supported interpretation;
6. the strongest remaining alternative or boundary.

Give the verdict after the evidence. Replace "performs significantly better"
with the actual metric, comparison, and value. Say what varied and what stayed
fixed. Include unfavorable cases when they define where the method works.

## Figures and tables

Every figure and table must support at least one claim. Its caption should state
the comparison and takeaway, define the evaluation direction, and expose any
condition needed to interpret it. The main text must tell the reader what to
inspect; "Figure 3 shows the results" is not enough.

When a figure or table is itself part of the supplied evidence, inspect it
before writing from it:

1. transcribe the axes, legend, units, conditions, and labeled values, including
   marks that are visible but not numerically identified;
2. establish the metric direction before calling a larger or smaller value
   better; if the direction is absent, describe only the plotted values;
3. distinguish values read directly from derived differences or trends, and
   make each derivation reproducible without narrating self-evident arithmetic;
4. separate observation from interpretation and from an untested mechanism;
5. do not infer variance, stability, or significance without the corresponding
   uncertainty, repetitions, or statistical procedure.

Report missing labels or conditions as interpretation limits. Never recover
them from visual convention, a remembered paper, or a plausible benchmark.

The first figure often bears disproportionate reading load, but do not create a
decorative overview to satisfy that convention. Use it for framing, mechanism,
or decisive evidence only when one of those jobs is useful.

Run two skim tests:

- title, abstract, figures, captions, and conclusion should recover the claims
  and evidence;
- the prose should remain logically complete when the figures are hidden.

## Discussion

Synthesize rather than repeat. Explain which findings converge, which conflict,
what mechanism remains plausible, and what the evidence changes. Keep measured
regularities, mechanism claims, and speculation visibly distinct.

Address the strongest alternative explanation where the reader first needs it.
When a toy model or narrow benchmark motivates a broader claim, state exactly
which mechanism may transfer and which parts have not been tested.

## Limitations

Do more than list disclaimers. For each limitation, give:

- the missing condition, control, population, or measurement;
- the consequence for a named claim;
- the evidence needed to remove the limitation.

Place a critical boundary near the claim it limits even if the paper also has a
dedicated Limitations section.

## Conclusion

Summarize only supported and mixed claims. Preserve their scope. Do not
introduce new evidence, inflate the impact, or end with generic optimism. A
useful conclusion leaves the reader with the result, its boundary, or the most
concrete unresolved question. Omit the section if the venue and paper do not
need it.

## Appendices

Put material in an appendix when it is necessary for verification or reuse but
not for following the main argument. Do not hide evidence required to believe a
central claim, definitions required to understand it, or limitations that
change its scope.
