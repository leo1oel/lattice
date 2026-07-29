# ADR: Project History uses semantic events over layered recovery backends

**Status:** Accepted

**Date:** 2026-07-29

## Context

Lattice has two legitimate histories:

- application transactions in `.research/history`, which describe direct edits and citation actions;
- turn checkpoints owned by the bundled Agent service, which can safely reverse an Agent turn.

Replacing either store with the other would discard useful semantics or duplicate a mature recovery
engine. The product still needs one place where users can understand changes across both systems.

## Decision

The **Changes** view is a merged, semantic timeline. It does not introduce a third recovery format.

- Lattice transactions remain the source of truth for editor, project, citation, and local restore
  events.
- Agent checkpoints remain the source of truth for Agent-turn file recovery.
- The embedded Agent surface sends checkpoint summaries to the host. Lattice presents them alongside
  local transactions and sends restore requests back to the Agent checkpoint engine.
- Local restores are forward-only: restoring creates a new transaction linked by `undoOf`; it never
  deletes the source transaction.
- A local restore fails closed if a target file no longer matches the state produced by the selected
  transaction.
- Git versions and Overleaf history keep their own storage and stay in separate tabs.

## Compatibility

History schema version 2 adds optional semantic metadata. Version 1 JSON records continue to decode;
their actor, kind, and source are inferred from the existing label without rewriting project data.

Agent checkpoint summaries are session data supplied by the embedded service. They are not copied
into `.research/history`.

## Consequences

- Users get one understandable activity timeline without coupling Lattice to the checkpoint storage
  implementation.
- Upstream checkpoint fixes remain reusable.
- Citation actions are distinguishable from ordinary editor writes.
- Older projects remain readable.
- Restoring checkpoints for an inactive Agent task requires opening that task first.
- A later phase can add task navigation, persisted cross-task checkpoint summaries, and richer
  conflict resolution without changing the core ownership boundary.
