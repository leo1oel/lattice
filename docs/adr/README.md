# Architecture decision records

An ADR records **a decision that was made, when, and why** — including decisions
that have since expired. It is deliberately not a description of current
behaviour: if you want to know how something works today, read the subsystem
document in [`../`](../), not an ADR.

The distinction matters because Lattice has already been bitten by the other
shape. `overleaf-integration-baseline.md` mixed durable protocol reference with
a dated project-stage snapshot, and the whole document rotted at the speed of
its fastest-moving half — including a contribution freeze that outlived its
stage without anyone noticing.

So: **dated reasoning goes here, present-tense reference goes in `docs/`.**

## Index

| ADR | Title | Status |
| --- | --- | --- |
| 0001 | [Project History is a merged semantic timeline](../project-history-architecture.md) | Accepted |
| 0002 | [Structured-Markdown CRDT evaluation](../markdown-structured-crdt-evaluation.md) | Rejected (NO-GO) |
| 0003 | [Overleaf integration stage baseline](0003-overleaf-stage-baseline.md) | Superseded — stage complete |

0001 and 0002 predate this directory and still live in `docs/` under their
original filenames. They are numbered here rather than moved so that existing
links keep working; new ADRs go in this directory.

## Writing one

Copy [`template.md`](template.md), take the next free number, and keep it short.
An ADR that needs a table of contents is probably a subsystem document.

Rules that come from experience rather than taste:

- **Date every measurement, and name what you measured it against.** A file
  count, a test count or a bundle size with no date and no reference commit
  becomes actively misleading within weeks.
- **Never put a rule contributors must follow only in an ADR.** ADRs are not on
  the path anyone reads before opening a pull request. If a decision constrains
  how people work, it belongs in `CONTRIBUTING.md` or the subsystem document as
  well.
- **Mark an ADR superseded rather than deleting it.** The point of the record is
  that the reasoning survives the decision.
