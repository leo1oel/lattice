# Lattice documentation

Lattice is a local-first LaTeX and Markdown writing environment for macOS:
a Tauri 2 (Rust) shell around a React 19 / TypeScript / Vite 8 frontend, with a
bundled AI-agent sidecar (Synara) and CRDT collaboration (Yjs + Cloudflare
Workers).

## Start here

Read in this order if you are new:

1. [`../README.md`](../README.md) — what the product is, how to install and run it.
2. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how to set up a dev environment and get a change merged.
3. **[`architecture.md`](architecture.md)** — the three processes (Rust host, webview, Node sidecar) and what crosses each boundary; the Rust command surface; the collaboration model; the on-disk `.research/` layout; the bundle and startup constraints; the design-system contract.
4. **[`codebase-map.md`](codebase-map.md)** — "if you want to change X, start at Y"; how `src/` is split into domain directories and what stays at its root; the ~17 files that matter; the known rough edges.
5. Then whichever subsystem doc below matches what you are touching.

`../CLAUDE.md` is a condensed version of the same constraints written for AI
coding agents. It is terser than these documents and, in places, less complete.
Where it disagrees with `architecture.md`, the longer document usually has the
fuller story — but do not treat a `path:line` citation as a tiebreaker on its
own. Line numbers in `architecture.md` and `codebase-map.md` are spot-checked
pointers, not guarantees, and they drift with every commit; the durable anchors
are file names, function names and constant names. When it matters, grep.

## Index

| Document | What it covers | Status |
| --- | --- | --- |
| [`architecture.md`](architecture.md) | Process boundaries, the Rust backend, collaboration v2, the on-disk data model, performance/bundle constraints, the design-system contract, the `pnpm check` gate. | Current |
| [`codebase-map.md`](codebase-map.md) | Where to start for each feature area; directory inventory; domain decomposition of `src/`; the largest files; known rough edges. | Current, but its counts are a snapshot of a moving tree: `src/App.tsx` is mid-extraction into `src/app/`, so its line count and hook counts drift between commits. Re-measure before quoting. |
| [`design-system.md`](design-system.md) | Typography, density, palette and spacing decisions — the reasoning behind the tokens that `src/styles/tokens.test.ts` enforces. | Current |
| [`synara-runtime.md`](synara-runtime.md) | The bundled agent sidecar: how to work without building it, the runtime boundary, the tool catalog the model actually sees, staging and pruning, and the upstream-sync procedure. | Current as of 2026-08-18, re-verified against the pinned fork revision. Its fork-size and tool-count figures are dated measurements — re-run the commands it gives rather than quoting them. |
| [`project-history-architecture.md`](project-history-architecture.md) | ADR 0001: why Project History is a merged semantic timeline over two stores (Lattice transactions in `.research/history` + agent turn checkpoints) rather than a third recovery format. | Accepted, and matches the code (history schema v2, forward-only restores linked by `undoOf`). |
| [`markdown-structured-crdt-evaluation.md`](markdown-structured-crdt-evaluation.md) | ADR 0002: evaluation of a native structured-Markdown CRDT (`Y.XmlFragment`) as a replacement for canonical `Y.Text("content")`. Decision: **NO-GO**. | Current, and confirmed: `src/editor/markdown/markdown-structured-crdt-prototype.ts` is imported by nothing except its own test. |
| [`performance.md`](performance.md) | Editor/startup performance: an industry survey, the verified list of what was actually slow, a measurement playbook using `scripts/gen-perf-fixture.mjs` and the `lattice-perf` probe, and a React Compiler status section. | Current, with one gap: the "Results log" is an empty template — no measurement has ever been recorded, and the doc says so rather than implying otherwise. The self-contradiction about the `notify` watcher and the incremental BM25 index (listed as unscheduled while the section above described both as landed) is fixed; both have shipped. |
| [`overleaf-protocol.md`](overleaf-protocol.md) | The Overleaf bridge: provenance ledger with pinned upstream commits, the license boundary, why the transport is Socket.IO **0.9**, the protocol and data invariants, the opt-in cloud tests, and what a wire-level change has to come with. | Current. Read it before touching `src/overleaf/` or `src-tauri/src/overleaf*.rs`. |
| [`adr/`](adr/README.md) | Architecture decision records — dated reasoning, including decisions that have expired. | Index at [`adr/README.md`](adr/README.md); [`adr/0003`](adr/0003-overleaf-stage-baseline.md) archives the Overleaf stage baseline and its lapsed contribution freeze. |
| [`release-process.md`](release-process.md) | How a release is cut: `scripts/bump-version.mjs`, the tag push, what `.github/workflows/release.yml` builds, signs and publishes, and why GitHub Releases is the changelog. macOS Apple Silicon only. | Current |

`overleaf-integration-baseline.md` was split. Its durable half — provenance,
license boundary, protocol invariants, the upstream-reference procedure — is now
[`overleaf-protocol.md`](overleaf-protocol.md). Its dated half — the Stage -1
framing, the `f7515eca` baseline, the test and lint snapshots, and a
protected-file freeze that lapsed without ever being announced — is archived as
[`adr/0003-overleaf-stage-baseline.md`](adr/0003-overleaf-stage-baseline.md).

`tldraw-integration-plan.md` was removed: it was a pre-implementation plan for
work that has since shipped (the whiteboard is `src/editor/board/board-editor.tsx` +
`src/editor/board/board-yjs-bridge.ts`), and its central file reference,
`src/tldraw-yjs-bridge.ts`, never existed. tldraw's licensing — the one part of
it that was still live — is covered by
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), which is more current
than the plan was (the plan described SDK 4.x; the repo pins `tldraw@5.2.5`).

## Related documents outside `docs/`

| Path | Contents |
| --- | --- |
| [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) | Attribution and license notes for vendored and bundled third-party code. |
| [`../LICENSE`](../LICENSE) | GPL-3.0-or-later. |
| [`../collab-server/README.md`](../collab-server/README.md) | Deploying and operating the Cloudflare Worker behind Lattice Shares. |
| [GitHub Releases](https://github.com/leo1oel/lattice/releases) | **The changelog.** There is no `CHANGELOG.md`; each tag's release notes are generated from the commit range. See [`release-process.md`](release-process.md#where-the-changelog-lives). |
| [`../video/README.md`](../video/README.md) | The standalone Remotion project for product videos. It is outside `pnpm check`. |
