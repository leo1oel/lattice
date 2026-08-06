# Bundled Synara runtime

Lattice ships a pinned build of our Synara fork as an application resource. Users do not need to
install Synara, Node.js, Bun, or start a separate service.

## Runtime boundary

- Tauri owns lifecycle only: prepare, start, health-check, report status, and stop.
- Synara remains an upstream-shaped Node service with its own SQLite and WebSocket layers.
- One sidecar is prewarmed per Lattice process and listens only on a dynamically selected
  `127.0.0.1` port.
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

The fork as a whole is **not** small. Measured against `upstream/main` at v0.7.0 it is 213 files
(46 added, 167 modified), roughly +14.5k/-9.7k lines. Beyond the host-profile seam it also carries
embedded-workspace UI, a skills manager, source-control and provider-health surfaces, and the
contract additions those require. Treat "keep it in the seam" as the goal for *new* work, not as a
description of the current state — and see [Syncing upstream](#syncing-upstream) for what that
size costs at merge time.

## Agent tool boundary

The Lattice profile renames Synara's tools rather than reimplementing them. `LATTICE_TOOL_ALIASES`
in the fork's `apps/server/src/agentGateway/hostProfile.ts` maps 16 upstream names onto Lattice's
task vocabulary, rewriting `thread` to `task` throughout:

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

`adaptToolsForActiveHost` drops every tool not in that map or in `LATTICE_NATIVE_TOOL_NAMES`, so
automations and browser control stay out of the Lattice catalog. Task creation and coordination are
in, which is a change from the phase-one read-only catalog.

Nine tools are Lattice-native. Five literature tools (`search_literature`, `fetch_paper`, `cite`,
`upgrade_bibliography`, `remove_reference`) delegate to the Lattice executable, keeping the Rust
literature and bibliography code as the only source of truth. Four canvas tools
(`list_canvas_shapes`, `create_canvas_shapes`, `update_canvas_shapes`, `delete_canvas_shapes`)
reach the tldraw surface through the Lattice canvas broker.

Renaming is not only structural. `replaceModelVisibleHostBranding` and `replaceStructuredBranding`
rewrite tool descriptions, input schemas, annotation titles, and every text and structured result
part, so no `synara` string reaches the model. The fork's
`apps/server/src/agentGateway/latticeModelBoundary.test.ts` asserts that the assembled provider
prompt matches no `/synara/i` and does contain `Lattice`, `mcp_servers.lattice`,
`lattice_host_context`, and `refs/lattice/checkpoints`.

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

The policy degrades honestly. When a provider session has no safely thread-scoped MCP connection,
`gatewayControlAvailable` is false and the model is told the Lattice task and literature tools are
unavailable, instead of being handed a tool list it cannot reach.

Everything upstream's policy says about `synara_*` tools, automations, and the embedded browser is
dropped for Lattice, matching the trimmed tool catalog.

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

## Build and release

[`scripts/synara-runtime.json`](../scripts/synara-runtime.json) is the source of truth for the fork,
branch, upstream repository, Node version, and exact Synara revision.

- `pnpm prepare:synara:dev` accepts a dirty local Synara checkout for development.
- `pnpm prepare:synara` is the release path. It refuses a dirty checkout or a revision that differs
  from the pin.
- The preparation script builds the production web/server artifacts, downloads the official
  target-specific Node binary, verifies its SHA-256 digest, installs production dependencies, and
  stages the result under `src-tauri/synara-runtime`.
- Tauri includes that directory through `bundle.resources`.

The current full-provider runtime is about 733 MB before installer compression. Treat runtime size
as a release metric; provider-specific lazy packaging is the next place to optimize if installer
size becomes a constraint.

## Syncing upstream

1. Fetch and merge `upstream/main` into `codex/lattice-embed` in the fork checkout. Do not rewrite
   the branch history. Tag a backup branch at the pre-merge commit first; the merge touches enough
   surface that a clean abort is worth having.
2. Prefer the host-profile seam for new work, and never reimplement an upstream tool handler. The
   fork already modifies 167 upstream files, so expect real conflicts in `wsRpc.ts`, the contracts
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

### Known-failing tests

These fail on the fork independently of any merge. Compare against this baseline instead of treating
them as sync regressions:

- `apps/web`: 13 React Compiler bailout assertions in `chatHotPath.compiler.test.ts` and
  `ChatMarkdown.compiler.test.ts`.
- `apps/server`: 7 assertions in `git/Layers/CursorTextGeneration.test.ts`, which need a real Cursor
  ACP connection.

Run the `apps/web` suite from the repository root, not from `apps/web`. Only the root
`vitest.config.ts` registers `vitest.setup.ts`, which installs the in-memory `localStorage` that
Node 24 does not provide; running from the workspace directory fails ~35 store tests for that reason
alone. Run the server and web suites sequentially — `AcpSdkConformance.test.ts` has a 90-second
timeout that CPU contention will trip.

Generated runtime contents are intentionally ignored by Git. Only the pin, preparation script,
supervisor, integration UI, and documentation belong in the Lattice repository.
