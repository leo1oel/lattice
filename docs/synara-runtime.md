# Bundled Synara runtime

Lattice ships a pinned build of our Synara fork as an application resource. Users do not need to
install Synara, Node.js, Bun, or start a separate service.

> **You almost certainly do not need to build this to work on Lattice.**
> See [Working without the sidecar](#working-without-the-sidecar).

## Working without the sidecar

Only `pnpm tauri dev` and `pnpm tauri build` need the Synara source. Everything else — `pnpm check`,
`pnpm dev`, `cargo test`, `cargo clippy` — needs nothing but an existing directory, because Cargo
compiles Tauri's resource manifest and that manifest expects `src-tauri/synara-runtime/` to exist:

```bash
mkdir -p src-tauri/synara-runtime && touch src-tauri/synara-runtime/placeholder.txt
```

That is the whole workaround, and it is what two of the three CI workflows do (`ci.yml` and
`release-cache.yml`; only `release.yml` stages the real runtime, because only it packages the app).
The directory is gitignored, so the stub stays out of your commits.

[`../CONTRIBUTING.md`](../CONTRIBUTING.md) is the authoritative setup guide, including how to point
`SYNARA_SOURCE_DIR` at a real checkout when you *are* changing the agent surface. This document
describes what the sidecar is and how it is built and synced; it is not a second setup guide.

## Runtime boundary

- Tauri owns lifecycle only: prepare, start, health-check, report status, and stop.
- Synara remains an upstream-shaped Node service with its own SQLite and WebSocket layers.
- The first Agent, source-control, review, or Agent-settings surface starts one sidecar for the Lattice process on a dynamically selected `127.0.0.1` port.
- Ordinary writing sessions never launch the bundled Node service; after the first request it remains alive because hidden surfaces may still own background turns or terminals.
- Tauri explicitly stops the sidecar on `RunEvent::Exit`; the sidecar also watches its launching
  Lattice PID and exits if the host disappears, so a crash cannot leave the SQLite lifecycle lock.
- Every launch gets a random authentication token. Lattice transfers it in the iframe fragment;
  Synara removes the fragment before opening authenticated WebSocket and HTTP routes.
- Runtime data lives under Lattice's app-data directory, not inside the application bundle.
- Telemetry and automatic browser launch are disabled for the bundled process.
- Lattice starts the fork with `AGENT_HOST_PROFILE=lattice`. The upstream-shaped default profile
  remains unchanged, so the same fork can still be tested against upstream behavior.
- The host profile owns every model-visible boundary: host prompt, MCP server identity, provider
  client identity, checkpoint namespace, and the exposed tool catalog.

The model-visible boundary is genuinely confined to the host profile: agent, provider, persistence,
checkpoint, and protocol implementations still come from Synara, and no upstream tool handler is
reimplemented.

Ownership stays split at that boundary. Synara owns provider adapters, turns, checkpoints, and the
provider-facing trace producer. Lattice owns live editor host context, the literature, canvas,
spreadsheet, and project-document brokers, and the host-side compile bridge.
In particular, Lattice does not copy a provider adapter.
Host context snapshots remain `version: 1` and include a `capturedAt` timestamp
plus an omission count when an explicit selection is truncated to the
`MAX_SELECTION_LENGTH` = 12,000-character model limit (`src/agent/agent-host-context.ts`).

The fork as a whole is **not** small. Measured on 2026-08-18 against `upstream/main` at
[`18ff9985`](https://github.com/Emanuele-web04/synara/commit/18ff99857d5b84adab2019c2839fa4f6df761b7c)
(2026-08-15), which is also the current merge-base, `git diff upstream/main...HEAD` on the pinned
revision reports **343 files changed (88 added, 255 modified), +30,292 / −3,627 lines**. Beyond the
host-profile seam it carries embedded-workspace UI, a skills manager, source-control and
provider-health surfaces, spreadsheet and canvas tool brokers, and the contract additions those
require. Treat "keep it in the seam" as the goal for *new* work, not as a description of the current
state — and see [Syncing upstream](#syncing-upstream) for what that size costs at merge time.

Re-measure rather than quoting those numbers; they move with every sync. From a checkout at the
pinned revision:

```bash
git fetch upstream && git diff --shortstat upstream/main...HEAD
```

## Agent tool boundary

The Lattice profile renames Synara's tools rather than reimplementing them. `LATTICE_TOOL_ALIASES`
in the fork's `apps/server/src/agentGateway/hostProfile.ts` maps **24** upstream names onto
Lattice's task vocabulary, rewriting `thread` to `task` throughout:

| Upstream | Lattice |
| --- | --- |
| `synara_context` | `context` |
| `synara_capabilities` | `agent_capabilities` |
| `synara_list_projects` | `list_projects` |
| `synara_list_threads` | `list_tasks` |
| `synara_read_thread` | `read_task` |
| `synara_read_thread_activity` | `read_task_activity` |
| `synara_read_thread_events` | `read_task_events` |
| `synara_read_thread_runtime_events` | `read_task_runtime_events` |
| `synara_diagnose_thread` | `diagnose_task` |
| `synara_wait_for_threads` | `wait_for_tasks` |
| `synara_create_thread` / `synara_create_threads` | `create_task` / `create_tasks` |
| `synara_send_message` | `send_message_to_task` |
| `synara_interrupt_thread` | `interrupt_task` |
| `synara_set_thread_title` | `set_task_title` |
| `synara_set_thread_archived` | `set_task_archived` |
| `synara_set_thread_goal` | `set_task_goal` |
| `synara_create_automation` | `create_automation` |
| `synara_list_automations` | `list_automations` |
| `synara_view_automation` | `view_automation` |
| `synara_update_automation` | `update_automation` |
| `synara_update_automation_memory` | `update_automation_memory` |
| `synara_cancel_automation` | `cancel_automation` |
| `synara_report_automation_result` | `report_automation_result` |

`adaptToolsForActiveHost` drops every tool that has neither an alias nor a place in
`LATTICE_NATIVE_TOOL_NAMES`. Two consequences worth stating explicitly, because both have changed
since the read-only phase-one catalog:

- **Automations are in.** Seven automation tools are aliased above, and the Lattice branch of the
  harness policy documents their modes, schedules, memory envelope and the mandatory
  `report_automation_result` call.
- **Browser control is out.** The `browser_*` tools have no alias and are not in the allowlist, so
  the embedded-browser surface never reaches the Lattice catalog.

`LATTICE_NATIVE_TOOL_NAMES` is an allowlist of **27** names that pass the filter *without* being
renamed. They are not all Lattice code:

| Group | Count | Names | Implemented by |
| --- | --- | --- | --- |
| Literature | 8 | `search_literature`, `list_papers`, `search_library`, `fetch_paper`, `fetch_web_reference`, `cite`, `upgrade_bibliography`, `remove_reference` | Lattice. They shell out to the Lattice executable, which parses them as the `LiteratureRequest` enum in `src-tauri/src/lib.rs` (grep `enum LiteratureRequest`) and dispatches to `literature::` and `papers::`, keeping the Rust literature and bibliography code the only source of truth. |
| Canvas | 4 | `list_canvas_shapes`, `create_canvas_shapes`, `update_canvas_shapes`, `delete_canvas_shapes` | Lattice. They reach the tldraw surface through the canvas broker (`src/agent/agent-canvas-tools.ts`, actions `list` / `create` / `update` / `delete`). |
| Spreadsheet | 2 | `spreadsheet_read`, `spreadsheet_batch_update` | Lattice, via `src/agent/agent-spreadsheet-tools.ts` (actions `read` / `batch_update`). |
| Project documents | 1 | `create_project_document` | Lattice. It creates and opens native `.tldr` boards or `.lattice-sheet` spreadsheets through the project transaction path, including shared-project catalog registration. |
| iOS Simulator | 12 | `device_list`, `device_boot`, `device_install`, `device_launch`, `device_open_url`, `device_tap`, `device_swipe`, `device_type`, `device_press_button`, `device_screenshot`, `device_describe_ui`, `device_scroll_to_element` | **Upstream**, from the fork's `deviceTools.ts`. They are allowlisted rather than implemented here, and Lattice enables them by passing `LATTICE_DEVICE_CONTROL_ENABLED=true` when it starts the sidecar (`src-tauri/src/synara.rs`). |

The mutating literature tools run with `HistoryMode::Defer`, so agent bibliography edits fold into
Lattice's own transaction history instead of committing independently.

Renaming is not only structural. `replaceModelVisibleHostBranding` and `replaceStructuredBranding`
rewrite tool descriptions, input schemas, annotation titles, and every text and structured result
part, so no `synara` string reaches the model. The fork's
`apps/server/src/agentGateway/latticeModelBoundary.test.ts` asserts that the assembled provider
prompt matches no `/synara/i` and does contain `Lattice`, `mcp_servers.lattice`,
`lattice_host_context`, `lattice_debug_mode`, `lattice_goal`, `set_task_goal` and
`refs/lattice/checkpoints`.

Every provider receives the Lattice bibliography policy. On macOS, Codex also runs inside a
process-level write boundary that rejects direct `.bib` writes; the Lattice literature broker runs
outside that boundary so approved citation tools can still update the bibliography.

## Host policy

`renderSynaraHarnessPolicy` in the fork's `apps/server/src/agentGateway/harnessPolicy.ts` branches on
the active profile and emits a completely separate policy block for Lattice. It is prepended to every
supported provider's prompt, so it is the highest-leverage piece of the fork: it defines what the
model believes it is running inside.

The Lattice branch declares Lattice as host and tool authority, scopes work to the active project
and permission mode, and documents the `<lattice_active_context>` block that trails user messages
with the live editor, PDF page, or cached paper view plus any explicit selection.

It also carries the rules that make the bibliography boundary real rather than advisory:

- `search_literature` is discovery only; results and metadata are not evidence, so the paper must be
  fetched or read before any source-grounded claim.
- Every bibliography mutation must go through `cite`, `upgrade_bibliography`, or `remove_reference`.
  Direct `.bib` writes are forbidden through file edits, patches, shell commands, scripts, and
  external bibliography utilities alike.
- No claim that a Lattice tool succeeded unless it returned a successful result.

The policy degrades honestly, on two axes. When a provider session has no safely thread-scoped MCP
connection, `gatewayControlAvailable` is false and the model is told the Lattice task, automation,
device and literature tools are unavailable, instead of being handed a tool list it cannot reach.
Independently, when `deviceControlAvailable` is false the simulator sentence is dropped and the model
is told not to reach for shell commands or OS automation instead.

The Lattice branch carries its own automation guidance rather than upstream's: modes (heartbeat,
standalone, dedicated), schedules, the `completionPolicy` stop clause, the 32 KiB
`update_automation_memory` envelope, and the requirement that every automation-dispatched turn
finish with `report_automation_result`.

Everything upstream's policy says about `synara_*` tool names and the embedded browser is dropped for
Lattice, matching the trimmed catalog.

## Project History bridge

The embedded Agent surface sends only semantic checkpoint summaries to its Lattice host: task and
turn identity, completion time, checkpoint ref, and per-file diff statistics. Lattice merges those
summaries with `.research/history` in the **Changes** timeline.

The two recovery stores retain separate ownership:

- editor, project, citation, and local restore transactions are restored by Lattice;
- Agent-turn file changes are restored by the existing checkpoint engine through a validated
  host-to-iframe message.

Lattice does not copy checkpoint contents into `.research/history`. A checkpoint from an inactive
task stays visible but cannot be restored until that task is open. See
[`project-history-architecture.md`](./project-history-architecture.md) for the schema and migration
decision.

For a new build-relevant Agent checkpoint, automatic-build mode waits for the build pass containing
those disk changes and relays `lattice:agent-compile-result` to the owning task and turn. The message
contains only checkpoint identity, timing, success, project-relative root document, and aggregate
error/warning counts. It never includes the build log, diagnostic text, paper content, or absolute
workspace root.

## Offline quality evaluation

Run `pnpm eval:agent` to replay the checked-in schema-version-1 research fixtures, or pass one or
more JSON/NDJSON trace paths after `--`. The harness correlates records by task and turn and exits
successfully only when every fixture's declared expected pass/fail outcome matches. It is entirely
offline: it does not contact a provider or the literature network. Vitest exercises individual
rules and malformed input in `scripts/agent-quality-eval.test.ts`.

Quality traces are content-minimized by default: record event types, status, hashes, paths, counts,
and correlation identifiers rather than prompts, model output, paper text, or tool payload content.
Synara writes the private, rotating NDJSON seam under its state log directory at
`agent-quality/agent-quality.ndjson`. It identifies the stable provider-session policy/tool prefix
separately from each turn's dynamic Lattice context manifest, so cache analysis does not require
moving live editor or paper context into the stable prefix.
Cache telemetry is provider-reported when available and otherwise explicitly unavailable; it must
not be interpreted as a complete account of a provider's cache behavior.

## Build and release

[`scripts/synara-runtime.json`](../scripts/synara-runtime.json) is the source of truth. It carries
`repository` (the fork), `upstream`, `branch`, `revision` (the exact pinned commit),
`sourceDirectory` (the default checkout location, which moves with the branch) and `nodeVersion`.
Read values from it — every script and workflow does, and hardcoding any of them is how this document
went stale before.

- `pnpm prepare:synara:dev` accepts a dirty local Synara checkout for development.
- `pnpm prepare:synara` is the release path. It refuses a dirty checkout or a revision that differs
  from the pin.
- The preparation script builds the production web/server artifacts, downloads the official
  target-specific Node binary, verifies its SHA-256 digest, installs production dependencies, and
  stages the result under `src-tauri/synara-runtime`.
- Claude sessions use the external `claude` executable selected in Provider settings (or found on
  the login-shell PATH). The SDK's otherwise bundled platform executable is replaced by a tiny PATH
  launcher so account probing follows the same installation without shipping a redundant copy.
- Tauri includes that directory through `bundle.resources`.

### Runtime size is a budget, not a note

Run `pnpm size:report` after preparing the runtime and building the frontend to record exact
file-byte totals for the web bundle, eager assets, Node binary, server distribution, runtime
dependencies, and provider executables.

The staged macOS runtime is **enforced**, not merely observed. `scripts/app-size-report.mjs` fails
the report when the measured runtime exceeds `MACOS_SYNARA_RUNTIME_BUDGET_BYTES` — **250 MiB**
uncompressed — and separately fails when a bundled Claude Agent SDK executable exceeds
`CLAUDE_PATH_LAUNCHER_BUDGET_BYTES` (4 KiB), which is how the PATH-launcher substitution above stays
honest. Read the current constants from that file rather than trusting a number quoted here; the
recorded totals belong in the release notes for the version that measured them.

Provider-specific lazy packaging is the next place to optimize if installer size becomes a
constraint.

## Syncing upstream

1. Fetch and merge `upstream/main` into **the branch named by `branch` in
   [`../scripts/synara-runtime.json`](../scripts/synara-runtime.json)** — today
   `amp/lattice-v0.7.3-sync`. The branch moves with each upstream version, so read it from the pin
   rather than from memory; older branches such as `codex/lattice-embed` still exist in the fork and
   are not what ships. Do not rewrite branch history. Tag a backup branch at the pre-merge commit
   first; the merge touches enough surface that a clean abort is worth having.
2. Prefer the host-profile seam for new work, and never reimplement an upstream tool handler. The
   fork modifies hundreds of upstream files, so expect real conflicts in `wsRpc.ts`, the contracts
   package, `GitCore.ts`, `providerMaintenance.ts`, and the chat components — merging is a review
   task, not a mechanical one.
3. Resolve conflicts hunk by hunk. Do not take one side wholesale for a whole file: our changes and
   upstream's frequently land in the same function, and conflict-block boundaries are often
   asymmetric, so a blanket `--theirs` can silently duplicate a function body.
4. Run `oxfmt --check`, then the workspace type checks, then the tests.
5. Start the staged server while another process owns port 3773; confirm it selects another
   loopback port and reports `startupReady`.
6. Push the fork commit and update the exact revision in `scripts/synara-runtime.json`.
7. Run `pnpm prepare:synara` and the Lattice frontend/Rust checks before producing an installer.

### Formatting must match upstream

The fork carries a `root = true` `.editorconfig`. Do not delete it. oxfmt reads EditorConfig's
`max_line_length` as its print width and walks *up* past the repository root, so a user-level
`~/.editorconfig` silently reformats the whole tree to a different width than upstream. That is how
the fork accumulated wide single-line reformatting that turned routine upstream syncs into a wall of
spurious formatting conflicts. Upstream's tree is oxfmt-clean at the default width of 100; ours must
stay that way.

### Running the fork's own test suite

Everything in this subsection is about **the Synara fork checkout, not this repository.** None of
these files exist under `research-writer/`; they are in the tree `SYNARA_SOURCE_DIR` points at, and
they only matter while you are performing a merge.

**Take your own baseline before you merge.** Run the suite on the pre-merge commit and keep the
output. Some tests fail on the fork independently of any merge — historically React Compiler bailout
assertions in `apps/web/src/components/chatHotPath.compiler.test.ts` and
`ChatMarkdown.compiler.test.ts`, and `apps/server/src/git/Layers/CursorTextGeneration.test.ts`, which
needs a real Cursor ACP connection — but the exact set drifts with upstream, so a count written down
here would be worse than useless. A pre-merge run is the only trustworthy baseline.

Two environment traps that are stable enough to record:

- **Run the `apps/web` suite from the fork's repository root, not from `apps/web`.** Only the root
  `vitest.config.ts` registers `vitest.setup.ts`, which installs an in-memory `localStorage`. Node 24
  exposes an experimental `localStorage` getter that resolves to `undefined` without
  `--localstorage-file`, and Zustand snapshots that `undefined` while modules load — before any test
  can stub it. Running from the workspace directory fails dozens of store tests for that reason
  alone.
- **Run the server and web suites sequentially.**
  `apps/server/src/provider/acp/AcpSdkConformance.test.ts` has a 90-second timeout that CPU
  contention will trip.

Generated runtime contents are intentionally ignored by Git. Only the pin, preparation script,
supervisor, integration UI, and documentation belong in the Lattice repository.
