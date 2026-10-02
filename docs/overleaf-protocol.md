# Overleaf bridge: protocol, provenance and compatibility

Lattice talks to Overleaf over the same endpoints Overleaf's own browser client
uses. They are **not a supported public API**: there is no contract, no
versioning and no deprecation notice. Everything Lattice relies on was observed,
and this document is the record of what was observed, what the implementation
now depends on, and what it takes to change any of it safely.

Read this before changing anything under `src-tauri/src/overleaf.rs` and
`overleaf/`, `src-tauri/src/overleaf_rt.rs` and `overleaf_rt/`, or `src/overleaf/`.

This document is not a legal opinion about license compatibility. The dated
project-stage material that used to live here — a baseline commit, test-count
snapshots, and a contribution freeze that has since lapsed — is archived in
[`adr/0003-overleaf-stage-baseline.md`](adr/0003-overleaf-stage-baseline.md).

## Source ledger

Every external link below is pinned to a commit. A moving branch may be used to
*discover* an update; it must never replace a pinned link here.

The "historical pin" column is honest about a gap: the commits that introduced
the integration (`72b8a804`, the REST bridge, and `81abdb14`, the realtime
transport, both 2026-07-24) name the projects consulted but not the revisions.
The reference snapshots are reproducible starting points for a future
comparison, not proof of what was read at the time. **Do not retroactively
invent a pin.**

| Source | Historical pin | Reference snapshot | License | How Lattice uses it |
| --- | --- | --- | --- | --- |
| [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) | **Unknown.** Latest default-branch commit available before Lattice's realtime work was [`72e8f4d4`](https://github.com/overleaf-workshop/Overleaf-Workshop/commit/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7) (2026-07-11) — a candidate, not proof. | [`72e8f4d4`](https://github.com/overleaf-workshop/Overleaf-Workshop/tree/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7): [`src/api/base.ts`](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/src/api/base.ts), [`src/api/socketio.ts`](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/src/api/socketio.ts), and its [`socket.io-client` patch](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/72e8f4d4753081fe44c817ef5bb98d2b7c27d2a7/patches/socket.io-client%2B0.9.17-overleaf-5.patch). | AGPL-3.0 | Reference for legacy Socket.IO 0.9 setup and event shapes. Lattice implements its own Rust transport; Workshop is not vendored. |
| [`moritzgloeckl/overleaf-sync`](https://github.com/moritzgloeckl/overleaf-sync) | **Unknown.** | [`aa62165e`](https://github.com/moritzgloeckl/overleaf-sync/tree/aa62165eb9eba48f8b8bf3d93358f9feed0bf5a9), especially [`olsync/olclient.py`](https://github.com/moritzgloeckl/overleaf-sync/blob/aa62165eb9eba48f8b8bf3d93358f9feed0bf5a9/olsync/olclient.py). Still the default-branch head on 2026-07-30. | MIT | Reference for browser-session authentication and REST project synchronization. Not a dependency. |
| [`katzper-michno/overleaf-sync-rs`](https://github.com/katzper-michno/overleaf-sync-rs) | **Unknown.** Older references may use the former owner path `km1chno/overleaf-sync-rs`, which redirects. | [`f884f07e`](https://github.com/katzper-michno/overleaf-sync-rs/tree/f884f07e06bd5b3750352fe845e956853025d5ab): [`olsync/src/overleaf_client.rs`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/olsync/src/overleaf_client.rs), [`olsync/src/auth.rs`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/olsync/src/auth.rs), [`socketio-client/src/client.py`](https://github.com/katzper-michno/overleaf-sync-rs/blob/f884f07e06bd5b3750352fe845e956853025d5ab/socketio-client/src/client.py). Still the default-branch head on 2026-07-30. | MIT | Secondary reference for session, project and sync request shapes. Not a crate or a vendored dependency. |
| Official [`overleaf/overleaf`](https://github.com/overleaf/overleaf) server | **Unknown.** | [`28ad3b03`](https://github.com/overleaf/overleaf/tree/28ad3b03b71cb4311decdcb55c36b33ec10d72db), default-branch head verified 2026-07-30. Entry points: [`services/web/app/src/router.mjs`](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/router.mjs), [`EditorRouter.mjs`](https://github.com/overleaf/overleaf/blob/28ad3b03b71cb4311decdcb55c36b33ec10d72db/services/web/app/src/Features/Editor/EditorRouter.mjs). | AGPL-3.0 | Authoritative evidence for Community Edition routes and payload handling. It does **not** prove Overleaf Cloud exposes an identical or stable contract. |

The local-project upload contract was separately verified against official commit [`6323fddbd8e584b76cf42a65faa15600d5ff218f`](https://github.com/overleaf/overleaf/tree/6323fddbd8e584b76cf42a65faa15600d5ff218f) from 2026-06-17.
The relevant evidence is [`UploadsRouter.mjs`](https://github.com/overleaf/overleaf/blob/6323fddbd8e584b76cf42a65faa15600d5ff218f/services/web/app/src/Features/Uploads/UploadsRouter.mjs#L20-L28), [`ProjectUploadController.mjs`](https://github.com/overleaf/overleaf/blob/6323fddbd8e584b76cf42a65faa15600d5ff218f/services/web/app/src/Features/Uploads/ProjectUploadController.mjs#L39-L77), and Overleaf's own [`use-project-uploader.tsx`](https://github.com/overleaf/overleaf/blob/6323fddbd8e584b76cf42a65faa15600d5ff218f/services/web/frontend/js/features/project-list/hooks/use-project-uploader.tsx#L19-L95).

On 2026-10-01 Overleaf Workshop was re-reviewed through default-branch head
[`63f105d`](https://github.com/overleaf-workshop/Overleaf-Workshop/tree/63f105dd71b6d5e44106e6fe5b5fc005b394b62f)
(2026-09-13), including its then-open PRs
[#419](https://github.com/overleaf-workshop/Overleaf-Workshop/pull/419),
[#418](https://github.com/overleaf-workshop/Overleaf-Workshop/pull/418),
[#406](https://github.com/overleaf-workshop/Overleaf-Workshop/pull/406) and
[#375](https://github.com/overleaf-workshop/Overleaf-Workshop/pull/375). That
review is not a historical pin and does not change the one above. The protocol
facts Lattice adopted from it were verified against Overleaf's own server and
client at official commit
[`e039ad26`](https://github.com/overleaf/overleaf/tree/e039ad26c5bf5422eb57b89fc7e57c75055e631d),
not taken from Workshop's code:

- `dupIfSource` and per-connection `publicId`:
  [`real-time/app/js/Router.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/Router.js),
  [`WebsocketController.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/real-time/app/js/WebsocketController.js),
  [`document-updater/app/js/sharejs/server/model.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/sharejs/server/model.js)
  and the web client's
  [`sharejs.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/web/frontend/js/vendor/libs/sharejs.js)
  (`inflightSubmittedIds`, and dropping an emptied operation);
- surrogate replacement:
  [`UpdateManager.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/UpdateManager.js)
  (`_sanitizeUpdate`);
- the update `hash`:
  [`ShareJsUpdateManager.js`](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/services/document-updater/app/js/ShareJsUpdateManager.js)
  (`_computeHash`);
- the heartbeat timeout: `socket.io-client` 0.9.17 `lib/socket.js`
  (`setHeartbeatTimeout`), the version Overleaf ships.

One provenance gap has no candidate at all: `OtDocument` in `src/overleaf/ot.ts` says
its client state mirrors the ShareJS client Overleaf uses, but no repository,
version or commit for that reference was recorded. Keep it **unknown** rather
than picking a plausible ShareJS snapshot after the fact.

### License boundary

Lattice is Apache-2.0. The two AGPL-3.0 projects above are protocol and
interoperability references; their source is not vendored here. The two MIT
projects are likewise references, not dependencies.

Before copying or adapting any upstream implementation:

1. record the exact source commit and file;
2. decide whether the change copies *expression* rather than only protocol
   facts;
3. get a license review and add any required notices before merging; and
4. keep upstream code out of fixtures and documentation unless redistribution
   has been explicitly approved.

Cross-language reimplementation is not by itself proof that no protectable
expression was carried over. This ledger makes review possible; it does not
replace it.

## Where the bridge lives

| Area | Responsibility | External evidence behind it |
| --- | --- | --- |
| `src-tauri/src/overleaf.rs` + `overleaf/` | Browser-session status, dashboard parsing, CSRF, ZIP download, REST upload and tree mutations, comments, project history, three-way file sync, sync state | `overleaf-sync`, `overleaf-sync-rs`, official server routes |
| `src-tauri/src/overleaf_rt.rs` + `overleaf_rt/` | Socket.IO 0.9 handshake and framing, heartbeat and ack dispatch, project/document joins, OT updates, tree events, presence, comments, tracked changes | Overleaf Workshop's `base.ts` / `socketio.ts`, official server behaviour |
| `src/overleaf/ot.ts` | Per-document client OT state, composition, transformation, version progression, desync detection; also moves comment quotes and tracked-change spans through the same ops that move the text, so Accept/Reject never act on a drifted range | Lattice tests and this document; the ShareJS reference is unpinned |
| `src/overleaf/use-overleaf-realtime.ts` | React-side document ownership, debounce, drain, reconnect, event handling, reviewer behaviour, comments, editor-buffer updates | Lattice application behaviour over the Rust channel |
| `src/app/use-overleaf-workspace.ts` (`useOverleafWorkspace`) | Owns `overleafSyncMode` and the workspace-level Overleaf state; consumed by `src/App.tsx`, which chooses between Overleaf OT and ordinary Overleaf sync, and excludes live-owned paths from ordinary sync | Lattice safety policy |
| `scripts/verify-overleaf.mjs` | Explicit opt-in cloud smoke test against a user-selected project and document | Live compatibility check; never a default test |

The wire format itself is documented where it is implemented, in the module
header of `src-tauri/src/overleaf_rt.rs` — handshake URL, upgrade URL, the nine
frame types, the exact frames Lattice emits, and the threading model. That
header is the authority; this document does not restate it, so that the two
cannot drift apart.

## Socket.IO 0.9, specifically

Overleaf ships `socket.io-client 0.9.17-overleaf-5`. That version number is the
single most important compatibility fact in the integration, because almost
every "Socket.IO client" available today speaks Engine.IO / Socket.IO v4, which
is a different protocol with a different handshake, different framing and a
different heartbeat. A modern client cannot talk to Overleaf at all.

What that implies, in practice:

- The handshake is a plain `GET` returning text
  `{sid}:{heartbeat}:{close}:{transports}`, not JSON. A redirect to `/login` or
  an HTML body means the session cookie is dead — that is the signal, and it
  must not be retried as a transport error.
- Frames are `{type}:{id}:{endpoint}:{data}`, with the trailing `:{data}`
  omitted when there is no payload. A heartbeat is therefore the three-byte
  string `2::`, and the server drops clients that do not echo it promptly.
- Ack ids are allocated by the client and are byte-visible in the frame
  (`5:{id}+::…`, answered with `6:::{id}+[…]`). Ack id `0` is reserved for the
  `1::` connect gate; the join slot is reserved separately. Collisions are silent
  and produce cross-talk between unrelated requests.
- There is no library between Lattice and the wire. Frame bytes, delimiters, ack
  allocation and heartbeat timing are all hand-written and all load-bearing.

Replacing the transport with a Socket.IO library, or "modernizing" the framing,
is not a refactor — it is a rewrite against a different protocol, and Overleaf
does not speak the other one.

## Protocol and data invariants

These are compatibility requirements, not implementation suggestions. See
[Changing the bridge](#changing-the-bridge) for what it takes to break one on
purpose.

### Authentication and HTTP

- Hosts are normalized to one origin. Redirects, cookie domains and websocket
  origins must not silently move authentication to another host.
- The browser session cookie is an **opaque credential**. Its name is
  `overleaf_session2` on Overleaf Cloud or `sharelatex.sid` on a self-hosted
  instance (`has_session_cookie` in `src-tauri/src/overleaf/account.rs`). It must never
  be normalized, partially reconstructed, or logged.
- The persisted session file is written through a private temporary file,
  synchronized, and atomically renamed. On Unix it stays mode `0600`. That
  limits accidental disclosure; it is **not** encryption, and moving the cookie
  into the macOS Keychain remains an open hardening step.
- Dashboard metadata parsing must keep supporting both the current and the
  legacy project-list meta tags, including HTML entity decoding.
- Mutating HTTP requests carry the CSRF value from the same authenticated
  origin.
- A transient failure is retried at most twice, with backoff, and only when
  the retry cannot do anything twice: any request that never connected or was
  answered 429 (honouring a `Retry-After` of up to 8 s), and a safe one (GET
  or HEAD) on a reset, 502, 503 or 504. An idempotent DELETE is not retried
  there: a repeat after it landed answers 404. Timeouts, other statuses and non-replayable
  bodies are never retried (`retry_wait` in `src-tauri/src/overleaf/api.rs`).
- Creating a project from local files uses `POST /project/new/upload` with
  multipart fields `name` and `qqfile`; success is identified by the returned
  `project_id`, not by a redirect.
- The initial upload archive contains the same filtered file set as ordinary
  synchronization, and local sync state is written only after Overleaf confirms
  project creation.
- A project ZIP is one downloaded snapshot. A later history version must never
  be recorded as the version that ZIP represents.
- A sync skips the ZIP only when Overleaf's history proves the copy the last
  sync agreed on still stands: the version has not moved, or every update since
  only edited documents the realtime channel holds. That copy is then rebuilt
  from local files and base copies whose hashes match it; anything that cannot
  be, any tree change, and any held hollow download mean downloading
  (`agreed_remote_files` in `src-tauri/src/overleaf/sync.rs`).
- Uploads run a few at a time, except that a file into a folder Overleaf may
  not have yet goes first and alone, so two uploads never race to create the
  same folder.
- Per-file upload requires the real root folder id returned by `joinProject`.
  The realtime connect command persists it before announcing that the channel is live, and the first automatic sync waits for that result.
  Upload paths are project-relative and must never contain `..`; Overleaf Cloud rejects traversal even when an older server happened to normalize it.

### Realtime transport

- The connection is legacy Socket.IO 0.9 framing — not Engine.IO, not Socket.IO
  v4. See [above](#socketio-09-specifically).
- Handshake, websocket upgrade, `Cookie` and `Origin` all refer to the same
  normalized origin and project.
- Frame type, ack id, endpoint, payload delimiters and the `2::` heartbeat are
  byte-sensitive. Ack ids and the reserved connection/project slots must not
  collide.
- `joinProject` must keep accepting every response form covered by fixtures,
  including a pushed `joinProjectResponse`.
- `joinDoc` is either a full join or a catch-up from a known version. Packed
  text, range decoding, version position and operation order are all preserved.
- **A document has at most one client operation in flight.** Work typed while
  waiting is composed; remote work is transformed against both the in-flight and
  the pending operation.
- **A timeout is not proof of rejection.** A document whose send outcome is
  unknown stays owned by OT until a late ack or a rejoin/catch-up proves what
  happened. Ordinary file sync must not resend it blindly.
- **Overleaf names every connection afresh.** The `publicId` it stamps on our
  updates as `meta.source` changes on every reconnect, so a document remembers
  every connection its in-flight operation went out on, and a replayed update
  from any of them is our own acknowledgement. After a replay on a *new*
  connection, the still-unanswered operation is resent with `dupIfSource`
  naming those connections — Overleaf then acknowledges a copy that already
  landed instead of applying it twice, which is what its own editor does. It is
  never resent on the connection that already carried it.
- An operation that transformed to nothing is dropped, never sent: an empty
  `applyOtUpdate` is not answered, and every later edit would queue behind it.
- Overleaf's document updater replaces every UTF-16 surrogate in inserted text
  with U+FFFD and still acknowledges the operation. Operations never split a
  surrogate pair, and inserted surrogates are replaced before sending — in the
  operation, the OT copy and the editor alike — so both sides keep identical
  text (`asOverleafStores` in `src/overleaf/ot.ts`).
- At most every five seconds per document, an update whose text is known
  exactly carries `hash` — SHA-1 of `blob {UTF-16 length}\0{UTF-8 text}`, the
  value Overleaf's document updater computes. A mismatch comes back as
  `otUpdateError`, which drops that document to ordinary sync rather than
  letting a drifted copy keep editing.
- Silence is a disconnect. When nothing arrives for the heartbeat timeout the
  handshake names (`{sid}:{heartbeat}:…`), the connection is ended and reported
  as `Disconnected`, exactly as the Socket.IO 0.9 client does; otherwise a
  half-open socket after sleep or a network change is never noticed.
- A transient disconnect retries with bounded exponential backoff. Network
  recovery and window focus may request an immediate retry, but authentication,
  authorization and project-identity failures stop the loop and require user
  action. Reconnect rejoins and reconciles uncertain documents before ordinary
  synchronization may own them again.
- Serialized Tauri event names, camelCase field names, command names and
  acknowledgement ordering are part of the frontend/backend contract.

### Synchronization and permissions

- `.research/overleaf.json` and `.research/overleaf-base/` describe the common
  ancestor **actually materialized locally**, not the newest remote state
  observed later.
- Conflict markers are never uploaded. Conflict copies stay local and stay
  excluded from synchronization.
- A sync never writes over or deletes a file that changed on disk since it read
  it. Editor saves wait out a sync behind the project lease, but agents and
  other programs do not; their edit is left as it is, keeps the previous agreed
  hash, and is reported (`editedDuringSync`) so the next sync merges or sends
  it. A file edited during its own upload keeps what went up as its merge base.
- Active, draining and outcome-unknown OT documents stay excluded from ordinary
  ZIP/file synchronization until the realtime owner releases them.
- Every delayed project-specific Overleaf read or mutation carries the project
  root captured by the UI. The backend rejects it if the app has since switched
  projects, and a mutating request holds the shared project lease so a root
  switch cannot reinterpret the operation midway.
- Only a freshly known `owner` or `readAndWrite` permission performs ordinary
  remote file mutations. `readOnly` and `Unknown` fail closed
  (`Permission::can_write` in `src-tauri/src/overleaf_rt/events.rs`); reviewers
  contribute only through tracked operations (`can_suggest`).
- Tree changes are identified by remote entity id. A rename or move must not
  become delete-and-recreate — that severs comments, tracked changes and
  document history.
- A failure partway through a multi-file sync must not mark unconfirmed files or
  versions as synchronized.

## Opt-in cloud tests

Ten Rust tests are `#[ignore]`d because they need a saved session and a real
project — two under `overleaf/`, eight in `overleaf_rt/tests.rs`:

| Area | Test |
| --- | --- |
| REST / project adoption | `opening_an_already_downloaded_project_opens_it` |
| REST / history | `reads_the_real_project_history` |
| Realtime connection | `connects_to_the_real_overleaf` |
| Realtime edit round trip | `edits_a_document_through_the_real_overleaf` |
| Two-client versioning | `a_collaborators_update_carries_the_version_it_applied_at` |
| Cross-document acknowledgement | `an_answer_still_arrives_after_joining_another_document` |
| Catch-up / replay | `rejoining_a_document_replays_what_was_missed` |
| Comment create/delete | `comments_on_a_real_document` |
| Suggest / withdraw | `tracks_a_change_on_the_real_overleaf` |
| Presence | `appears_present_on_the_real_overleaf` |

> **These hit overleaf.com with your own account and several of them write.**
> They mutate project text, comments or presence and then
> attempt to restore what they changed. An interrupted run leaves the project
> mid-change.
>
> Run them only against a **sacrificial project you are willing to lose**, with
> a fresh backup, and never in CI.

`pnpm verify:overleaf -- "<project folder>" ["<document name>"]` wraps the
connection test and, when a document is named, the edit and comment round trips.
It is opt-in for the same reason.

Nothing in the default suite touches the network. `pnpm check` proves the local
OT state machine and the mocked REST/realtime behaviour; it proves nothing about
current Overleaf Cloud compatibility.

## Changing the bridge

Ordinary bug fixes and UI work in `src/overleaf/` need nothing special. The bar
below applies to changes that touch the **wire format, the OT semantics, the
permission model, or persisted sync state** — the things a test suite full of
fixtures will happily keep passing while real Overleaf compatibility breaks.

Such a change needs all four of:

1. **A fixture that fails on the old behaviour.** Minimal, credential-free, and
   representing the actual upstream response or frame. "The tests still pass" is
   not evidence when the tests encode the old assumption.
2. **A stated reason the upstream protocol changed**, with the commit or capture
   that shows it — not an inference from a bug report.
3. **A rollback that does not discard local work.** Keep the prior compatibility
   path behind a narrow capability decision until the new one is verified.
4. **Failure-mode analysis for the fail-closed cases**: unknown permission,
   unknown send outcome, partial multi-file sync, conflict copies.

Two rules have no exception:

- **Never silently fall back to a weaker mutation.** If a frame or endpoint
  changes and no proven parser handles it, fail closed for mutations, retain
  local edits, and report the degraded capability. Do not turn a protocol error
  into a whole-project upload.
- **Never run the ignored cloud mutation tests without explicit authorization**
  and a sacrificial project.

Some specific changes look like cleanups and are not:

- swapping the hand-written transport for a Socket.IO client library (see
  [above](#socketio-09-specifically));
- changing frame bytes, ack allocation, heartbeat behaviour, event order, Tauri
  command names or serialized payload shapes;
- changing OT transform semantics or the one-in-flight rule;
- deleting a "redundant" compatibility parser or an old persisted-state field;
- making unknown permissions writable, or downgrading reviewer operations to
  ordinary edits;
- letting REST/file sync own an active, draining or uncertain OT document;
- replacing conflict/base-copy behaviour with last-writer-wins.

If you want to do one of these, that is a design discussion — open an issue
first.

## Updating an upstream reference

Use this whenever an Overleaf or reference-project update is considered:

1. Record the candidate repository, full commit SHA, commit date, license, and
   the exact files inspected. Never document only `main`, `master` or `latest`.
2. Compare only the relevant upstream files against the pinned snapshot. State
   which observed **protocol fact** changed; do not copy upstream implementation
   text into an issue or a fixture.
3. Classify the change: parsing-only, additive capability, wire behaviour,
   persisted-state behaviour, or destructive mutation behaviour.
4. Add the minimal credential-free fixture from
   [Changing the bridge](#changing-the-bridge) step 1.
5. Run the deterministic gates — `pnpm check` covers the frontend, OT, Rust,
   formatting, lint and Clippy stages.
6. If local fixtures cannot prove cloud compatibility, get explicit approval for
   a low-frequency smoke test on a sacrificial project. Preserve the before
   state and verify restoration.
7. Keep the prior compatibility path available until the new one is verified.
8. Update the [source ledger](#source-ledger) with the new pinned commit,
   evidence date, affected invariants, test results and any license review.
