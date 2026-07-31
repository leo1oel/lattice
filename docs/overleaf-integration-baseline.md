# Overleaf integration provenance and compatibility baseline

- Status: Stage -1 baseline
- Last evidence refresh: 2026-07-30
- Lattice source baseline: [`f7515eca95c726e0279941d46a86faacc832a0b6`](https://github.com/leo1oel/lattice/commit/f7515eca95c726e0279941d46a86faacc832a0b6)

This document is the safety boundary for changes to Lattice's Overleaf
integration. It records where protocol knowledge came from, which behavior the
current implementation relies on, and which tests must remain green. It does
not claim that Overleaf's browser endpoints are a supported public API, and it
is not a legal opinion about license compatibility.

The inspected working tree contained unrelated user changes. The Lattice commit
above identifies the checked-in source baseline; counts under
[Test baseline](#test-baseline) identify whether they were measured before or
after the current safety work.

## Source ledger

Every external link in this table is pinned to a commit. A moving branch may be
used to discover updates, but it must not replace a pinned link here.

| Source | Historical pin used by the 2026-07-24 implementation | Verifiable reference snapshot | License | Lattice use |
| --- | --- | --- | --- | --- |
| [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) | **Unknown.** The Lattice history names the project and files but does not record the upstream commit. The latest default-branch commit available before Lattice's realtime work was [`72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7`](https://github.com/overleaf-workshop/Overleaf-Workshop/commit/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7), dated 2026-07-11; this is a reproducible candidate, not proof of the snapshot originally consulted. | [`72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7`](https://github.com/overleaf-workshop/Overleaf-Workshop/tree/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7), including [`src/api/base.ts`](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/src/api/base.ts), [`src/api/socketio.ts`](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/src/api/socketio.ts), and its [`socket.io-client` patch](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/patches/socket.io-client%2B0.9.17-overleaf-5.patch). | AGPL-3.0 | Reference for legacy Socket.IO 0.9 setup and event shapes. Lattice implements its own Rust transport; Workshop is not vendored. |
| [`moritzgloeckl/overleaf-sync`](https://github.com/moritzgloeckl/overleaf-sync) | **Unknown.** No upstream commit is stored in Lattice history. | [`aa62165eb9eba48f8b8bf3d93358f9feed0bf5a9`](https://github.com/moritzgloeckl/overleaf-sync/tree/aa62165eb9eba48f8b8bf3d93358f9feed0bf5a9), especially [`olsync/olclient.py`](https://github.com/moritzgloeckl/overleaf-sync/blob/aa62165eb9eba48f8b8bf3d93358f9feed0bf5a9/olsync/olclient.py). This was still the default-branch head on 2026-07-30. | MIT | Reference for browser-session authentication and REST project synchronization behavior. It is not a dependency. |
| [`katzper-michno/overleaf-sync-rs`](https://github.com/katzper-michno/overleaf-sync-rs) | **Unknown.** Earlier references may use the repository's former owner path `km1chno/overleaf-sync-rs`, which redirects to the canonical URL. | [`f884f07e06bd5b3750352fe845e956853025d5ab`](https://github.com/katzper-michno/overleaf-sync-rs/tree/f884f07e06bd5b3750352fe845e956853025d5ab), including [`olsync/src/overleaf_client.rs`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/olsync/src/overleaf_client.rs), [`olsync/src/auth.rs`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/olsync/src/auth.rs), and [`socketio-client/src/client.py`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/socketio-client/src/client.py). This was still the default-branch head on 2026-07-30. | MIT | Secondary reference for session, project, and synchronization request shapes. It is not a crate or vendored dependency. |
| Official [`overleaf/overleaf`](https://github.com/overleaf/overleaf) server | **Unknown.** Lattice history says "current server source" but stores no commit. | [`28ad3b03b71cb4311decdcb55c36b33ec10d72db`](https://github.com/overleaf/overleaf/tree/28ad3b03b71cb4311decdcb55c36b33ec10d72db), the default-branch head verified on 2026-07-30. Relevant entry points include [`services/web/app/src/router.mjs`](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs) and [`EditorRouter.mjs`](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Editor/EditorRouter.mjs). | AGPL-3.0 | Authoritative evidence for Community Edition routes and payload handling. It does not prove that Overleaf Cloud exposes an identical or stable contract. |

Lattice's initial REST bridge entered history in
[`72b8a804380a1c997baab0c68e39eea46e987709`](https://github.com/leo1oel/lattice/commit/72b8a804380a1c997baab0c68e39eea46e987709)
on 2026-07-24. The Rust realtime transport entered history later that day in
[`81abdb14e03cd3556f0b012289909d6abd50c460`](https://github.com/leo1oel/lattice/commit/81abdb14e03cd3556f0b012289909d6abd50c460).
Those commits establish when Lattice code appeared, not the exact revisions of
the external repositories consulted.

One additional provenance gap remains: `src/ot-document.ts` says its client
state mirrors the ShareJS client used by Overleaf, but the repository, version,
and commit for that reference were not recorded. Do not choose an arbitrary
ShareJS snapshot after the fact. Keep the historical pin as **unknown** until
commit history or another contemporaneous artifact can prove it.

### License boundary

Lattice is Apache-2.0. The two AGPL-3.0 projects above are recorded as protocol
and interoperability references; their source is not vendored into this
repository. The two MIT projects are also references rather than dependencies.

Before copying or adapting any upstream implementation:

1. record the exact source commit and file;
2. identify whether the change copies expression rather than only using
   protocol facts;
3. obtain a license review and add any required notices before merging; and
4. keep upstream code out of fixtures and documentation unless redistribution
   has been explicitly approved.

Cross-language reimplementation alone is not proof that no protectable
expression was carried over. This ledger makes review possible; it does not
replace it.

## Lattice reference map

| Lattice area | Current responsibility | External evidence used |
| --- | --- | --- |
| `src-tauri/src/overleaf.rs` | Browser-session status, dashboard parsing, CSRF, ZIP download, REST upload and tree mutations, comments, project history, three-way file sync, and sync state | `overleaf-sync`, `overleaf-sync-rs`, and official server routes |
| `src-tauri/src/overleaf_rt.rs` | Socket.IO 0.9 handshake and framing, heartbeat and ack dispatch, project/document joins, OT updates, tree events, presence, comments, and tracked changes | Overleaf Workshop's `base.ts` / `socketio.ts` and official server behavior |
| `src/ot-document.ts`, `src/ot-ops.ts`, `src/ot-transform.ts` | Per-document client OT state, composition, transformation, version progression, and desync detection | Lattice tests and local protocol documentation; the exact ShareJS reference remains unpinned |
| `src/use-overleaf-realtime.ts` | React-side document ownership, debounce, drain, reconnect, event handling, reviewer behavior, comments, and editor-buffer updates | Lattice application behavior layered on the Rust channel |
| `src/App.tsx` | Chooses between Overleaf OT, ordinary Overleaf sync, and Lattice Share; excludes live-owned paths from ordinary sync | Lattice safety policy |
| `scripts/verify-overleaf.mjs` | Explicit opt-in cloud smoke tests against a user-selected project and document | Live compatibility check; never a default test |

## Protocol and data invariants

These are compatibility requirements, not implementation suggestions. A change
that breaks one must first add a fixture proving that the upstream protocol
changed and must provide a rollback path.

### Authentication and HTTP

- Hosts are normalized to one origin. Redirects, cookie domains, and websocket
  origins must not silently move authentication to another host.
- The browser session cookie is an opaque credential. Its name may be
  `overleaf_session2` on Overleaf Cloud or `sharelatex.sid` on a self-hosted
  instance. It must never be normalized, partially reconstructed, or logged.
- The persisted session file is written through a private temporary file,
  synchronized, and atomically renamed. On Unix it must remain mode `0600`.
  This limits accidental disclosure but is not encryption; moving the cookie
  into the macOS Keychain remains a separate hardening step.
- Dashboard metadata parsing must continue to support the current and legacy
  project-list meta tags and HTML entity decoding.
- Mutating HTTP requests require the CSRF value from the same authenticated
  origin.
- A project ZIP is one downloaded snapshot. A later history version must never
  be recorded as the version represented by an older ZIP.
- Per-file upload requires a valid folder id. Lattice's temporary anchor-folder
  workaround and cleanup are one compatibility path; replacing it requires a
  tested root-folder-id path and a safe fallback.

### Realtime transport

- The connection uses legacy Socket.IO 0.9 framing, not Engine.IO or modern
  Socket.IO v4 framing.
- Handshake, websocket upgrade, `Cookie`, and `Origin` must refer to the same
  normalized origin and project.
- Frame type, ack id, endpoint, payload delimiters, and the three-byte heartbeat
  `2::` are byte-sensitive. Ack ids and the reserved connection/project slots
  must not collide.
- `joinProject` must continue to accept the response forms already covered by
  fixtures, including a pushed `joinProjectResponse`.
- `joinDoc` can be a full join or a catch-up from a known version. Packed text,
  range decoding, version position, and operation order must be preserved.
- A document may have at most one client operation in flight. Work typed while
  waiting is composed, and remote work is transformed against both in-flight
  and pending work.
- A timeout is not proof of rejection. A document with an unknown send outcome
  remains owned by OT until a late ack or a rejoin/catch-up proves what
  happened; ordinary file sync must not resend it blindly.
- A transient disconnect retries with bounded exponential backoff. Network
  recovery and window focus may request an immediate retry, but authentication,
  authorization, and project-identity failures stop the loop and require user
  action. Reconnect must rejoin and reconcile uncertain documents before
  ordinary synchronization can own them again.
- Serialized Tauri event names, camelCase field names, command names, and
  acknowledgement ordering are part of the frontend/backend contract.

### Synchronization and permissions

- `.research/overleaf.json` and `.research/overleaf-base/` describe the common
  ancestor actually materialized locally, not merely the newest remote state
  observed later.
- Conflict markers are never uploaded. Conflict copies remain local and remain
  excluded from synchronization.
- Active, draining, and outcome-unknown OT documents stay excluded from
  ordinary ZIP/file synchronization until the realtime owner releases them.
- Every delayed project-specific Overleaf read or mutation carries the project
  root captured by the UI. The backend rejects it if the app has since switched
  projects, and a mutating request holds the shared project lease so a root
  switch cannot reinterpret the operation midway through it.
- Only a freshly known `owner` or `readAndWrite` permission may perform ordinary
  remote file mutations. `readOnly` and unknown permissions do not mutate;
  reviewers contribute only through tracked operations.
- Tree changes are identified by remote entity id. Rename or move must not
  become delete-and-recreate, because that would sever comments, tracked
  changes, and document history.
- A failure partway through a multi-file sync must not mark unconfirmed files
  or versions as synchronized.

## Test baseline

### Deterministic local baseline

Before the current Gate 1 safety edits, the verified backend baseline was:

```text
cargo test --manifest-path src-tauri/Cargo.toml overleaf
69 passed; 0 failed; 12 ignored
```

That is the **pre-change** baseline, not a claim about the final integrated
working tree. The parent integration pass must record its post-change result
after all parallel work has settled.

The Stage -1 documentation pass independently verified on 2026-07-30:

```text
pnpm exec vitest run overleaf
14 test files passed; 133 tests passed

pnpm exec vitest run src/ot-document.test.ts
1 test file passed; 17 tests passed
```

These commands cover mocked REST/realtime UI behavior and the local OT state
machine. They do not demonstrate current Overleaf Cloud compatibility.

After the integrated Gate 1 changes, the deterministic checks that do not need
a local listening socket were:

```text
pnpm test
84 test files passed; 584 tests passed

pnpm exec vitest run overleaf ot-document collab-project-io conflict-markers
18 test files passed; 180 tests passed

pnpm build
passed

cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
passed

cargo test --manifest-path src-tauri/Cargo.toml overleaf --no-run
compiled all Rust Overleaf tests
```

The new pure Rust generation, permission, and base-finalization safety tests
also passed. The full post-change Rust HTTP/WebSocket mock suite still requires
permission to bind a loopback port; until it is rerun, the pre-change
`69 passed / 12 ignored` result remains the last complete backend runtime
baseline. This limitation does not authorize the ignored real-cloud tests.

The reconnect, project-scope, and session-file hardening pass was checked in
the current integration worktree on 2026-07-30:

```text
pnpm test
86 test files passed; 571 tests passed

pnpm build
passed

pnpm lint
0 errors; 126 existing warnings

cargo check --manifest-path src-tauri/Cargo.toml
passed

cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
passed

cargo test --manifest-path src-tauri/Cargo.toml a_delayed_overleaf_action_cannot_move_to_the_new_project --lib
1 passed

cargo test --manifest-path src-tauri/Cargo.toml session_file_is_private_and_round_trips_without_a_partial_file --lib
1 passed
```

No real Overleaf project was mutated by this pass. Cloud and self-hosted
acceptance still require an explicitly selected sacrificial project.

### Opt-in cloud tests

Twelve Rust tests are ignored by default because they require a saved session
and a selected real project:

| Area | Ignored test |
| --- | --- |
| REST/settings | `turns_suggestions_on_for_this_account` |
| REST/project adoption | `opening_an_already_downloaded_project_opens_it` |
| REST/history | `reads_the_real_project_history` |
| Realtime connection | `connects_to_the_real_overleaf` |
| Realtime edit round trip | `edits_a_document_through_the_real_overleaf` |
| Two-client versioning | `a_collaborators_update_carries_the_version_it_applied_at` |
| Track-changes setting event | `turning_suggestions_on_comes_back_on_the_channel` |
| Cross-document acknowledgement | `an_answer_still_arrives_after_joining_another_document` |
| Catch-up/replay | `rejoining_a_document_replays_what_was_missed` |
| Comment create/delete | `comments_on_a_real_document` |
| Suggest/withdraw | `tracks_a_change_on_the_real_overleaf` |
| Presence | `appears_present_on_the_real_overleaf` |

`pnpm verify:overleaf -- "<project folder>" ["<document name>"]` is a convenience
wrapper for the connection test and, when a document is supplied, the edit and
comment round trips. Several ignored tests mutate project text, comments,
settings, or presence before attempting to restore them. They must never run
in CI or against a user's important project. Run them only with explicit
authorization, a sacrificial project, and a fresh backup.

## Protected surface during the first phase

Stage -1 is documentation and measurement only: no `src/` or `src-tauri/`
source change belongs to this stage.

Until a later gate explicitly approves a protocol change, treat these files as
a protected compatibility core:

- `src-tauri/src/overleaf_rt.rs`
- `src/ot-document.ts`
- `src/ot-ops.ts`
- `src/ot-transform.ts`
- the wire-facing portions of `src/use-overleaf-realtime.ts`
- the persisted-state and merge portions of `src-tauri/src/overleaf.rs`

Narrow data-safety fixes may touch a protected file during Gate 1, but they
must not also perform cleanup, renaming, dependency replacement, or abstraction
work. In particular, the first phase forbids:

- replacing the current transport with Overleaf Workshop code or a different
  Socket.IO client;
- moving or rewriting the realtime module for architectural neatness;
- changing frame bytes, ack allocation, heartbeat behavior, event order, Tauri
  command names, or serialized payload shapes;
- changing OT transform semantics or the one-in-flight rule;
- deleting compatibility parsers or old persisted-state fields;
- making unknown permissions writable or downgrading reviewer operations to
  ordinary edits;
- allowing REST/file sync to own an active, draining, or uncertain OT document;
- replacing conflict/base-copy behavior with last-writer-wins; or
- running real-cloud mutation tests without explicit user authorization.

Any exception needs a focused regression test, before/after wire or state
fixture, failure-mode analysis, and a feature-level rollback that does not
discard local work.

## Updating an upstream reference

Use this process whenever an Overleaf or reference-project update is considered:

1. Record the candidate repository, full commit SHA, commit date, license, and
   exact files inspected. Never document only `main`, `master`, or `latest`.
2. Compare only the relevant upstream files against the pinned snapshot. State
   which observed protocol fact changed; do not copy upstream implementation
   text into an issue or fixture.
3. Classify the change as parsing-only, additive capability, wire behavior,
   persisted-state behavior, or destructive mutation behavior.
4. Add a minimal, credential-free fixture that fails on the old Lattice
   behavior and represents the new upstream response or frame.
5. Run the deterministic frontend, OT, Rust, formatting, lint, and Clippy gates.
6. If local fixtures cannot prove cloud compatibility, request explicit
   approval for a low-frequency smoke test on a sacrificial project. Preserve
   the before state and verify restoration.
7. Keep the prior compatibility path behind a narrow rollback or capability
   decision until the new path has been verified. Never silently fall back to
   a mutation with weaker safety.
8. Update this ledger with the new pinned commit, evidence date, affected
   invariants, test results, and any license review.

If an upstream endpoint or frame changes without a proven safe parser, fail
closed for mutations, retain local edits, and report the degraded capability.
Do not turn a protocol error into a whole-project upload.
