# 0003. Overleaf integration stage baseline

- **Status:** Superseded — the stage completed and the freeze it imposed lapsed.
  Confirmed lapsed on **2026-08-18** by the evidence in
  [Status changes](#status-changes).
- **Date:** 2026-07-30
- **Deciders:** repository maintainer

> **This is a historical record.** The numbers, the stage names and the
> protected-file freeze below describe the repository as it stood at version
> **0.1.174** in July 2026. None of it governs current work. The durable
> protocol facts that were originally interleaved with this material now live in
> [`../overleaf-protocol.md`](../overleaf-protocol.md), which is the document to
> read before touching the Overleaf bridge.

## Context

In late July 2026 the Overleaf integration had just been written — the REST
bridge landed in `72b8a804` on 2026-07-24 and the Rust realtime transport in
`81abdb14` the same day — and it had been written against undocumented browser
endpoints. Three problems arrived together:

1. **Provenance was unrecorded.** The implementation had been guided by four
   external projects, and none of the commits named the upstream revisions
   consulted. Two of those projects are AGPL-3.0 while Lattice is
   GPL-3.0-or-later, so "which code did we look at, and did we copy expression
   or only protocol facts" was a question nobody could answer from history.
2. **The protocol knowledge lived only in the code.** Byte-level Socket.IO 0.9
   framing, ack allocation, the one-in-flight OT rule and the exclusion of
   OT-owned documents from file sync were all load-bearing and all implicit.
   Any refactor could break Overleaf compatibility without failing a test.
3. **A refactor was likely.** The realtime module was large and freshly written,
   which is exactly the state that invites cleanup.

The response was a staged plan. **Stage -1** was declared to be documentation
and measurement only, followed by a **Gate 1** allowing narrow data-safety fixes
into otherwise frozen files.

## Decision

Write a provenance ledger and compatibility baseline before changing anything,
and freeze a named set of files while that work happened.

The baseline was pinned to Lattice commit
[`f7515eca95c726e0279941d46a86faacc832a0b6`](https://github.com/leo1oel/lattice/commit/f7515eca95c726e0279941d46a86faacc832a0b6)
(2026-07-29, version 0.1.174).

### The freeze, as written

> Stage -1 is documentation and measurement only: no `src/` or `src-tauri/`
> source change belongs to this stage.

The protected compatibility core was:

- `src-tauri/src/overleaf_rt.rs`
- `src/overleaf/ot-document.ts`, `ot-ops.ts`, `ot-transform.ts`
  (then at `src/ot-*.ts`)
- the wire-facing portions of `src/overleaf/use-overleaf-realtime.ts`
  (then `src/use-overleaf-realtime.ts`)
- the persisted-state and merge portions of `src-tauri/src/overleaf.rs`

Narrow data-safety fixes could touch a protected file during Gate 1, but the
first phase forbade nine classes of change: replacing the transport with
Overleaf Workshop code or another Socket.IO client; moving or rewriting the
realtime module for architectural neatness; changing frame bytes, ack
allocation, heartbeat behaviour, event order, Tauri command names or serialized
payload shapes; changing OT transform semantics or the one-in-flight rule;
deleting compatibility parsers or old persisted-state fields; making unknown
permissions writable or downgrading reviewer operations to ordinary edits;
allowing REST/file sync to own an active, draining or uncertain OT document;
replacing conflict/base-copy behaviour with last-writer-wins; and running
real-cloud mutation tests without explicit user authorization.

### Measurements taken at the time

These are the snapshots the original document carried. **They are not current**
and should not be compared against a modern run — the suite, the lint debt cap
and the gate itself have all changed since.

Pre-Gate-1 backend baseline:

```text
cargo test --manifest-path src-tauri/Cargo.toml overleaf
69 passed; 0 failed; 12 ignored
```

Verified 2026-07-30 during the documentation pass:

```text
pnpm exec vitest run overleaf
14 test files passed; 133 tests passed

pnpm exec vitest run src/overleaf/ot-document.test.ts
1 test file passed; 17 tests passed
```

After the integrated Gate 1 changes:

```text
pnpm test
84 test files passed; 584 tests passed

pnpm exec vitest run overleaf ot-document collab-project-io conflict-markers
18 test files passed; 180 tests passed
```

After the reconnect, project-scope and session-file hardening pass
(2026-07-30):

```text
pnpm test
86 test files passed; 571 tests passed

pnpm lint
0 errors; 126 existing warnings
```

The full post-change Rust HTTP/WebSocket mock suite was never rerun in that
worktree — it needs permission to bind a loopback port — so `69 passed / 12
ignored` remained the last complete backend runtime baseline of the stage.

No real Overleaf project was mutated by any pass recorded here.

## Consequences

The stage produced its intended artifact: a provenance ledger with pinned
upstream commits, an explicit license boundary, and a written set of protocol
invariants. That material was durable and survives in
[`../overleaf-protocol.md`](../overleaf-protocol.md).

The freeze did not survive contact with the project, and the way it failed is
the more useful lesson:

- **It was never discoverable.** `CONTRIBUTING.md` never mentioned it. No CI
  check enforced it. The strings "Stage -1" and "Gate 1" appeared in exactly one
  file in the repository, and that file was a subsystem document a contributor
  had no particular reason to open before editing `overleaf_rt.rs`.
- **It had no expiry and no owner.** "Until a later gate explicitly approves a
  protocol change" names a gate that was never defined, scheduled or declared
  complete anywhere.
- **It froze files by path.** Within three weeks the repository restructure moved
  `src/ot-*.ts` and `src/use-overleaf-realtime.ts` into `src/overleaf/`, so the
  freeze list stopped matching the tree it protected.

The corrective actions taken in 2026-08 were to split the document, retire the
stage vocabulary, and move the parts a contributor genuinely must know —
"protocol changes need a fixture and a rollback path", "never run the ignored
cloud tests against a project you care about" — into
[`../overleaf-protocol.md`](../overleaf-protocol.md) with a pointer from
`CONTRIBUTING.md`.

## Status changes

**2026-08-18 — superseded; the stage is over.** Determined from `git log` rather
than from any declaration, because none was ever made. The evidence:

| Signal | Measurement |
| --- | --- |
| Releases since the baseline | **54** tags contain `f7515eca`; version went 0.1.174 → 0.1.229 |
| Commits since the baseline | **176** (2026-07-29 → 2026-08-17) |
| Change to the protected files | `overleaf.rs` +724/−…, `use-overleaf-realtime.ts` +721/−…, `overleaf_rt.rs` +25 — **+1,267 / −203 lines total** |
| Feature work through the protected surface | `462ce17` (2026-08-08) reworked the Overleaf chat panel and connect flow; `72d508e` (2026-08-13) added 140 lines of project-control behaviour to `overleaf.rs` |
| Explicitly forbidden class of change performed | The realtime module and the OT files **were moved** into `src/overleaf/`, which the freeze listed as forbidden |
| Any surviving stage machinery | None. No issue, workflow, template or other document in the repository refers to Stage -1 or Gate 1 |

Two details are worth separating out, because they are not simply "the rule was
ignored":

- The one change to `overleaf_rt.rs` (`7f79278`, 2026-07-31) was precisely the
  kind of narrow data-safety fix Gate 1 permitted: it made `Permission::Unknown`
  fail closed for direct edits and added `can_suggest()` so reviewers keep
  tracked operations. It came with a unit test. That change was in-policy.
- The three OT core files — `ot-document.ts`, `ot-ops.ts`, `ot-transform.ts` —
  have **no content commits** since the baseline. The transform semantics and
  the one-in-flight rule the freeze most wanted to protect are in fact
  untouched. Only their paths changed.

So the freeze is retired as a *process gate*, not as a judgement that the OT
core became unstable. The substantive requirement it encoded — a wire or
persisted-state change needs a fixture that fails on the old behaviour and a
rollback that does not discard local work — is not a stage rule and now lives in
[`../overleaf-protocol.md`](../overleaf-protocol.md) as ordinary review policy.
