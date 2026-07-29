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

This boundary keeps the fork small: Lattice-specific behavior is selected in one host-profile
adapter, while agent, provider, persistence, checkpoint, and protocol implementations continue to
come from Synara.

## Agent tool boundary

The phase-one Lattice profile reuses Synara's read and diagnostic implementations under neutral
tool names:

- `context`
- `list_threads`
- `read_thread`
- `read_thread_activity`
- `read_thread_events`
- `read_thread_runtime_events`
- `diagnose_thread`

Thread creation, automations, and browser control stay out of the Lattice catalog until their
product surfaces are implemented. The five literature tools (`search_literature`, `fetch_paper`,
`cite`, `upgrade_bibliography`, and `remove_reference`) delegate to the Lattice executable, which
keeps the Rust literature and bibliography code as the only source of truth.

Every provider receives the Lattice bibliography policy. On macOS, Codex also runs inside a
process-level write boundary that rejects direct `.bib` writes; the Lattice literature broker runs
outside that boundary so approved citation tools can still update the bibliography.

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
   the branch history.
2. Keep the Lattice changes isolated to the dynamic-port/embed integration and the
   `agentGateway/hostProfile` seam. Reuse upstream tool handlers; do not fork their business logic.
3. Run the Synara web/server type checks and targeted tests, then build both production artifacts.
4. Start the staged server while another process owns port 3773; confirm it selects another
   loopback port and reports `startupReady`.
5. Push the fork commit and update the exact revision in `scripts/synara-runtime.json`.
6. Run `pnpm prepare:synara` and the Lattice frontend/Rust checks before producing an installer.

Generated runtime contents are intentionally ignored by Git. Only the pin, preparation script,
supervisor, integration UI, and documentation belong in the Lattice repository.
