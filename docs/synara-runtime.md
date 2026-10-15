# Bundled Synara runtime

Lattice ships a pinned build of our Synara fork as an application resource. Users do not need to
install Synara, Node.js, Bun, or start a separate service.

> **You almost certainly do not need to build this to work on Lattice.**
> See [Working without the sidecar](#working-without-the-sidecar).

## Working without the sidecar

Only `pnpm tauri dev` and `pnpm tauri build` need the Synara source.
Everything else — `pnpm check`, `pnpm dev`, `cargo test`, `cargo clippy` — needs only a stub directory, because Cargo compiles Tauri's resource manifest and that manifest expects the bundled Synara runtime path to exist:

```bash
mkdir -p src-tauri/synara-runtime
touch src-tauri/synara-runtime/placeholder.txt
```

That is the whole workaround, and it is what two of the three CI workflows do (`ci.yml` and `release-cache.yml`; only `release.yml` stages the real runtimes, because only it packages the app).
The directory is gitignored, so the stub stays out of your commits.

[`../CONTRIBUTING.md`](../CONTRIBUTING.md) is the authoritative setup guide, including how to point
`SYNARA_SOURCE_DIR` at a real checkout when you *are* changing the agent surface. This document
describes what the sidecar is and how it is built and synced; it is not a second setup guide.

## Runtime boundary

- Tauri owns lifecycle only: prepare, start, health-check, report status, and stop.
- Synara remains an upstream-shaped Node service with its own SQLite and WebSocket layers.
- The first Agent, source-control, review, or Agent-settings surface starts one sidecar for the Lattice process on a dynamically selected `127.0.0.1` port.
- Ordinary writing sessions never launch the bundled agent service; after the first request it remains alive because hidden surfaces may still own background turns or terminals.
- Sidecar startup and health polling run on a blocking worker, so the native event loop can paint the localized loading surface immediately. The loader also covers the lazy panel module and stays up until the embedded composer has committed.
- The embedded client reports readiness from the committed composer, without waiting for animation frames while the host covers the frame. Embedded headers use a named, tooltip-equipped handoff icon, and the standalone rail card border is suppressed in embeds.
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
The Lattice host policy reserves the manuscript's live build outputs for the host preview queue.
Agents that need mid-turn compilation must isolate all generated outputs rather than run a second compiler against the preview's `.aux`, PDF, or SyncTeX files; this is model guidance, not a filesystem sandbox guarantee.
Fresh agent checkpoints, including undo, enter the ordinary Overleaf sync queue independently of automatic-build mode.
In live sync mode, affected text files leave realtime editing, retain any unacknowledged OT operations until settled, and rejoin after reconciliation; manual sync mode does not upload automatically.
On macOS, `SYNARA_PROCESS_PS_PATH` points to a shell launcher for the signed Lattice executable's `--lattice-process-snapshot` mode, which exits before Tauri starts.
The mode reads `KERN_PROC_ALL` directly under the existing bibliography sandbox; it must not copy `/bin/ps`, whose non-setuid copy can be killed on older macOS even when static signature verification passes.
The two supported `ps`-shaped queries return PID/parent relationships and opaque birth-time identities rather than command-line arguments.
A missing PID is a successful empty result; the pinned fork treats every nonzero host snapshot exit as unknown rather than proof of exit.
The fork selects the host's opaque-identity protocol when `SYNARA_PROCESS_PS_PATH` is set and retains upstream's `lstart` identity checks for ordinary `ps`.
This behavior and its regression tests now live in Synara's `processTreeController`, rather than a compiled-bundle staging patch; both its synchronous scan and the asynchronous teardown scan Synara 1.0.4 added use the host launcher.
Startup verifies the launcher inside the sandbox before admitting agent work.

The macOS host sets `LATTICE_BIBLIOGRAPHY_SANDBOX=1` only when launching the service through its bibliography sandbox.
`scripts/synara-codex-host.mjs` makes Codex inherit that protection instead of running a second `sandbox-exec`, which can fail before Codex starts on older macOS.
The standalone Lattice-profile Codex guard remains in place when the marker is absent.
The staging patch resolves the Codex logger from its unique declaration, so upstream bundle-symbol reordering cannot send these events to a different provider logger. It records classified Codex stderr and process exit even after stdout EOF has begun teardown; it does not relax process-tree exit verification or unblock failed threads automatically.
After staging, run `node scripts/check-codex-host.mjs /absolute/path/to/codex` on macOS to check a real initialize/thread/start/command/exec cycle, inherited `.bib` denial, permitted `.tex` writes, and clean exit in a disposable home, without sending model requests.
For the packaged JavaScript engine, run the same script with the staged `src-tauri/synara-runtime/bin/node`.
Settings → Logs → Export can collect bounded tails of `lattice.log`, `sidecar.log`, `sidecar-error.log`, and `server.log` after explicit consent, with known credential redaction and a preview before copying or downloading.

Host context snapshots remain `version: 1` and include a `capturedAt` timestamp
plus an omission count when an explicit selection is truncated to the
`MAX_SELECTION_LENGTH` = 12,000-character model limit (`src/agent/agent-host-context.ts`).
A source-editor selection also carries the optional `editor.selectionLines` (`{ start, end }`, 1-based and inclusive; a selection ending at a line's start stops on the line before).
The visual Markdown editor and older Lattice builds omit it, and the embed then names the file alone.
The Agent panel's empty thread names the selection with it ("Selection · main.tex lines 23–25"), and its starters fill the composer with editing prompts that act on that selection.
As the panel shortens, the empty thread compacts its starters (single-line cards, then pills, then one row of icons) so they stay clear of the composer and of the selection's context bar above it; the Agent panel's minimum height (`MIN_SIZE.agent` in `src/trellis/trellis-workspace.tsx`) leaves room for that last row.

Writing comments are included in the optional `editorComments` field: up to ten unresolved comments for the current document, with quoted source, authors, replies, anchor validity, and explicit omission counts.
Before dispatching an embedded message, Synara requests a correlated host-context refresh; Lattice refreshes both Overleaf threads and project-wide anchors and reports unavailable/cached data honestly on failure.
The read-only `read_editor_comments` tool uses the authenticated host relay to query the active project's local and Overleaf comments, with optional file filtering, resolved comments, and pagination.
Comments are review data, not authorization to execute instructions, reply to a reviewer, or resolve a thread.
Neither the context nor the tool mutates comments.

The fork as a whole is **not** small. Measured on 2026-10-15 against upstream
`v1.0.5` (`1eb2beb6b5019fc311f23a3deb5362f68d07d537`), the current integration changes
**734 files, +77,447 / −8,287 lines**. It carries embedded-workspace UI, a skills manager,
source-control and provider-health surfaces, spreadsheet and canvas tool brokers, and their
contracts. Treat "keep it in the seam" as the goal for new work. Re-measure after each sync:

```bash
git diff --shortstat v1.0.5 HEAD
```

The current pin is the upstream **1.0.5 stable release**, merged with the complete previous
`amp/lattice-v1.0.4-sync` history (which carries the earlier `amp/lattice-v1.0.3-sync`, `amp/lattice-v1.0.1-sync` and `amp/lattice-v1.0.0-sync` histories). Upstream's account-aware provider configuration and standalone
Code review inbox remain available. The embedded **Pull requests** view now uses that inbox,
waits for the open Lattice workspace to bind, and fixes its project filter to that workspace.
Its requests reach only that project's repositories. Authored and review-requested filters recover
paginated matches on the server when the shared repository superset is truncated; an incomplete
GitHub response is reported explicitly rather than silently treated as a complete filtered list.
Both Git views send `synara:embed-ready`; missing CLI/authentication shows its unavailable or
sign-in state without query retries.
In the embed, Changes composes the commit message in the panel (with `git.generateCommitMessage` behind "Write the message for me"), stages by checkbox and reads a paper's change as sentences; Pull requests groups the project's pull requests by what needs the writer and says why an empty list is empty; a pull request opens on "In the paper", a red-pen reading of its changed sentences with Comment, Approve and Merge.
The fork's `docs/lattice-git-embed.md` describes these views and the data they read. The inbox, its filters and the item detail follow the host
locale through the fork's Lingui catalogs (zh-CN included); GitHub content and agent prompts stay
as written. The narrow model picker retains account selection in upstream’s
new account-aware menu, and TeX, BibTeX, `.sty`, and `.cls` files retain their file icons.
The inbox, detail panes, sidechat dock, and portalled menus inherit Lattice's embed-theme surface
tokens; code and diff renderers also resolve the host theme without changing standalone Synara's
stored appearance preferences.
The agent panel and the Settings frame also accept the `lattice:host-theme` version-1 palette (tint, accent, and translucency as computed role colors) over `postMessage` and ask for it with `lattice:request-host-theme`; without one they keep the Graphite palette, and they stay opaque whatever the translucency.
Its optional `panel` role is the Settings sheet, under group cards on `elevated`; a runtime that predates it leaves the page on `elevated`.
Its optional `editor` role is the editor's page: in the light theme the agent's user bubbles, code, inline code, empty-thread starters and provider-status card sit on it rather than on `elevated`, which Graphite keeps pure white for menus; the dark theme keeps them on `elevated`.
Each frame holds the handshake it booted with (its config, the `#lattice-auth` credential and the last palette) for the life of its document; the `window.name`-keyed sessionStorage slot is only the copy a reload recovers from, so losing it can no longer repaint the panel with Synara's own white palette or strip the credential from attachment image URLs.
Providers, MCP and Skills follow the native Settings layout (a serif page title, each group's rows in one bordered card at 52px), and Settings tells their frame `lattice:settings-layout` `{compact}` when the window crosses its 680px breakpoint, since the frame sees only its own column width.

## Agent tool boundary

The Lattice profile renames Synara's tools rather than reimplementing them. `LATTICE_TOOL_ALIASES`
in the fork's `apps/server/src/agentGateway/hostProfile.ts` maps **25** upstream names onto
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
| `synara_show_visual` | `show_visual` |

`adaptToolsForActiveHost` drops every tool that has neither an alias nor a place in
`LATTICE_NATIVE_TOOL_NAMES`. Two consequences worth stating explicitly, because both have changed
since the read-only phase-one catalog:

- **Automations are in.** Seven automation tools are aliased above, and the Lattice branch of the
  harness policy documents their modes, schedules, memory envelope and the mandatory
  `report_automation_result` call.
- **Browser control is out.** The `browser_*` tools have no alias and are not in the allowlist, so
  the embedded-browser surface never reaches the Lattice catalog.

### Synara 0.9 Computer Use boundary

The upstream `/computer-use` command activates Computer for one request; ordinary turns remain off by default.
The command is retained, but Lattice currently rejects its send preflight with an explicit unavailable message and preserves the draft.
It does not dispatch a provider task that lacks the required Computer tools.
The Lattice catalog continues to exclude `computer_*`, including driver-backed browser tools, while the standalone Synara profile retains upstream's catalog, approvals, and request-scoped capabilities.

macOS Computer Use requires a GUI-owned Cua host, authenticated host socket, pinned native driver, permission checks, physical Escape monitoring, and reliable input cleanup.
Upstream's Electron host implements those responsibilities; Lattice's Tauri host does not yet implement them.
Enabling the command's native operations requires that host integration and validation against the signed Lattice application, not a broader iframe token or a standalone driver launched from the agent server.
No Accessibility, Screen Recording, or Input Monitoring permissions are requested by this upgrade.

### Synara 0.9.1 compatibility

The 0.9.1 integration includes the upstream Opus 5.5 and GPT-6 Sol/Luna catalog updates, OpenCode startup fixes, and projection/provider/sidebar optimizations.
Model availability still depends on the installed provider runtime and account access.
Lattice already wrote server-settings migration version 3 before this upgrade, so existing version-3 Git-writing selections remain unchanged; new settings use upstream's GPT-6 Luna default.
The compile-repair model remains a separate setting, and the Computer Use boundary above is unchanged.
The new batched thread-shell query preserves Lattice's `pendingMessageId`, with a regression covering latest-turn ties, duplicate and missing thread IDs, and null versus populated message identities.
The project-import announcement never opens automatically in Lattice embeds, even when a loopback-port change makes its dismissal storage unavailable; manual import remains available.

### Synara 0.9.2 compatibility

The 0.9.2 integration retains Lattice's host contracts and incorporates persistent provider model catalogs, restart-orphaned turn recovery, scoped session approvals, credential redaction on approval cards, and hardened stdio/frame transports.
The previous fork's sent-message anchoring and wide-chat navigation fixes remain in the upgrade history.

Lattice uses the Stable feature boundary on both the server and embedded web surface.
Upstream otherwise treats a loopback HTTP host without a Synara desktop bundle identity as a standalone host and enables Beta-only features.
OMP remains unavailable in Lattice, and the embedded UI does not show the Beta welcome or installation surfaces.
Synara 1.0.0 moved Inbox and Auto-fix CI into Stable, so Lattice's embedded pull-request controls now offer upstream's opt-in Auto-fix CI watcher.
Synara 1.0.1 moved Tasks into Stable as well; it lives in the standalone sidebar and Inbox, which Lattice does not embed.
Synara 1.0.2 moved Hubs (formerly Groups) and their Library into Stable, so no feature is Beta-only any more; Hubs live in the standalone rail and sidebar, which Lattice does not embed either.
Standalone Synara retains its upstream flavor behavior, and the Computer Use boundary above remains unchanged.

### Synara 1.0.3 compatibility

The 1.0.3 integration (through 1.0.2) adds compact subagent run cards and background-task rows to the transcript, turn headers for stopped and interrupted turns, a follow-up queue that pauses after Stop, an error or a usage limit, faster transcript recovery, and Claude's optional cold-cache resume prompt (**Ask before resuming a long idle session**, under the Claude provider settings).
Their embedded-panel copy is in the zh-CN catalog.
Upstream's chat-managed Tasks tools (`synara_create_todo`, `synara_list_todos`, `synara_update_todo`) have no Lattice alias, so `adaptToolsForActiveHost` drops them: Tasks has no surface in Lattice, and a to-do list the writer cannot see would only confuse the agent's task vocabulary.
Provider enablement stays ungated in the Lattice profile; the new per-account instance list still reaches the gateway and External MCP callers.
The fork treats `defaults read com.openai.codex` answering "Domain … not found" (macOS 27's wording for a user who never ran Codex) as no managed preference, so Proofread's isolated Codex path no longer fails closed there.

### Synara 1.0.4 compatibility

The 1.0.4 integration adds faster long-chat opening and steadier scrolling: unmeasured transcript rows get a content-aware size hint through upstream's `@legendapp/list` patch, which the fork's patch file now carries together with Lattice's floating-composer anchoring dependency, and the open chat subscribes once at startup instead of twice.
A quit marks a running turn interrupted; after an unexpected stop (Lattice or the sidecar killed mid-turn), the next start sends the chat a guarded continuation that tells the agent to verify what already completed. The fork lets that recovery find the running turn's request through its pending message, which upstream's stored messages do not link, and the continuation names Lattice rather than Synara because it reaches the model. Codex turns also survive delayed terminal notifications.
The Lattice host policy now tells the agent to repeat `wait_for_tasks` with the returned run ids until every delegated task is terminal, as upstream's own policy does.
The sidebar's **Working and unread on top** ordering, browser tabs that keep their page, and Hubs keeping their chosen access mode are standalone surfaces that Lattice does not embed.
Inline visuals (`synara_show_visual`) were Beta-only in 1.0.4, so the Stable feature boundary kept them out of Lattice; the Computer Use paste and recovery fixes leave the boundary above unchanged.
Pi still runs on its SDK without a CLI probe, but now reports "not set up" (localized in zh-CN) when neither an instance API key nor a configured Pi credentials or models file exists, instead of showing ready.

### Synara 1.0.5 compatibility

The 1.0.5 composer is a single pill row (+, draft, microphone, send) for every chat in the embed, since the embed has no centered landing; it grows into the block layout for a second line or a long draft, and Lattice's empty-thread starters stay above it.
Activity above the input (live changes, tasks, workflow, goal, tips, Auto-fix CI, reconnecting) floats as capsules whose panels open in popovers; queued follow-ups keep the stacked rail, and the Lattice context bar floats above them all.
The row under the composer carries the model picker and context ring; the embed leaves out upstream's permission menu there, because Lattice's Agent header owns the permission mode.
The /, @ and + menus and the capsules take Lattice's composer surface (`--lattice-agent-composer-surface`), opaque like every embedded panel, and the embed's placeholder names Lattice.
Inline visuals moved into Stable, so the Lattice profile now offers `synara_show_visual` as `show_visual`; the host policy tells the agent to prefer component blocks and to send HTML only for what blocks cannot draw.
The profile's branding rewrite makes the agent place a `lattice-visual` fence, which the transcript accepts beside `synara-visual`.
Upstream runs HTML visuals only in Electron, whose subframe guard stops a page that navigates its own frame (carrying data in the URL) before the request.
The fork gives every HTML visual that guarantee in any engine: the transcript frame loads a host document under the visual's content security policy, whose only child is the visual's own frame, so the visual's navigations are checked against that parent's `frame-src 'none'` and refused before anything is sent (`buildInlineVisualHostDocument` in the fork's `packages/shared/src/inlineVisual.ts`).
Both frames are `srcdoc` documents sandboxed with `allow-scripts allow-forms` only (never `allow-same-origin`, popups, or top navigation), so the visual has an opaque origin with no access to the panel, Lattice, cookies, storage or the host bridge; the policy blocks every network load, and the host page relays only messages between the panel and the visual, where only the size, scroll and stop notifications are acted on.
The bootstrap also removes any frame the visual nests before it loads, since a nested window would bring back the WebRTC constructors CSP cannot govern.
The visual's toolbar copies its source, saves it as HTML, and expands it, and Lattice does the last two: WebKit cancels a download from a frame, so the panel posts `synara:save-visual` `{filename, html}` and Lattice saves it through a save panel (`save_agent_visual`), refusing sources over the runtime's 256 KiB limit; and the panel is often too narrow to enlarge a visual inside it, so it posts `synara:expand-visual` `{title, html, document}` and Lattice loads that host document, unchanged and under the same sandbox, in a dialog over its window (`src/agent/agent-visual-dialog.tsx`), reading nothing from it but its reported height and an Escape the page left alone.
Both messages are parsed in `src/agent/agent-visual-save.ts`; an expand request whose document does not begin with the visual policy is ignored.
The animated ASCII background and its Appearance switch belong to the standalone empty landing, so the embed keeps its own empty thread; the Activity Priority section and its `mod+alt+a` cycle, the sidebar without subagent rows, remote MCP connectors (Beta-only) and browser focus fixes are standalone surfaces too.
When a provider handoff is refused because the source still runs background tasks, the composer offers **Stop tasks and switch**.
Without Lattice changes, 1.0.5 also pins Claude's **Ask for approval** to Claude Code's default permission mode, stops double-counting Claude usage (cache reads are reported apart), and resolves a chat's task state in one pass so task-heavy chats open faster.
`device_wait`, `device_logs` and `device_configure` join the allowlisted simulator tools, since the existing device tool descriptions now point to them.
The new strings that render in the panel are in the zh-CN catalog.

`LATTICE_NATIVE_TOOL_NAMES` is an allowlist of **32** names that pass the filter *without* being
renamed. They are not all Lattice code:

| Group | Count | Names | Implemented by |
| --- | --- | --- | --- |
| Literature | 8 | `search_literature`, `list_papers`, `search_library`, `fetch_paper`, `fetch_web_reference`, `cite`, `upgrade_bibliography`, `remove_reference` | Lattice. They shell out to the Lattice executable, which parses them as the `LiteratureRequest` enum in `src-tauri/src/agent_literature.rs` (grep `enum LiteratureRequest`) and dispatches to `literature::` and `papers::`, keeping the Rust literature and bibliography code the only source of truth. |
| Canvas | 4 | `list_canvas_shapes`, `create_canvas_shapes`, `update_canvas_shapes`, `delete_canvas_shapes` | Lattice. They reach the tldraw surface through the canvas broker (`src/agent/agent-canvas-tools.ts`, actions `list` / `create` / `update` / `delete`). |
| Spreadsheet | 2 | `spreadsheet_read`, `spreadsheet_batch_update` | Lattice, via `src/agent/agent-spreadsheet-tools.ts` (actions `read` / `batch_update`). |
| Project documents | 1 | `create_project_document` | Lattice. It creates and opens native `.tldr` boards or `.lattice-sheet` spreadsheets through the project transaction path. |
| Editor comments | 1 | `read_editor_comments` | Lattice, answered through the shared host-tools poll below. |
| Presentations | 1 | `preview_presentation_page` | Lattice. The fork relays `{deck, page, step}` like the canvas tools; `src/agent/agent-presentation-tools.ts` brings the presentation runtime up to date with the disk, asks it to compile the deck (`deckBuildErrors` in `tools/open-slide-runtime/server.mjs`; a deck that does not build is answered with `presentation_build_failed` and Vite's located errors), opens its token-gated preview entry in a hidden 1920 × 1080 frame, and the preview page rasterizes itself (`PREVIEW_CAPTURE_SOURCE` in `tools/open-slide-runtime/server.mjs`). The model receives the JPEG as image content, so no shell or local browser is needed. |
| iOS Simulator | 15 | `device_list`, `device_boot`, `device_configure`, `device_install`, `device_launch`, `device_open_url`, `device_tap`, `device_swipe`, `device_type`, `device_press_button`, `device_screenshot`, `device_describe_ui`, `device_scroll_to_element`, `device_wait`, `device_logs` | **Upstream**, from the fork's `deviceTools.ts`. They are allowlisted rather than implemented here, and Lattice enables them by passing `LATTICE_DEVICE_CONTROL_ENABLED=true` when it starts the sidecar (`src-tauri/src/synara.rs`). |

The mutating literature tools run with `HistoryMode::Defer`, so agent bibliography edits fold into
Lattice's own transaction history instead of committing independently.

The agent panel receives every host-answered tool request (bibliography, canvas, spreadsheet, project
document, editor comments, presentation) through one long poll, the fork's
`/api/lattice/host-tools/poll`, and posts each result to that tool's own result route.
A new host tool joins that shared queue instead of adding a poll: each held poll occupies one of the
six HTTP/1.1 connections WebKit allows the sidecar origin, and when six were held the panel's own
scripts waited behind them, so it stayed on "Restoring the conversation surface" for a full poll
cycle on every open.

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

The diagnostics panel's **Fix all** action is a separate, user-initiated flow, not part of that telemetry relay.
It saves open buffers, sends all current errors and warnings to one independent Synara task using **Settings → Models → Compile repair model**, and recompiles after the task completes.
The task inherits the Agent panel's selected permission mode (including full access) for both creation and turn start; it never silently substitutes a different mode.
The repair model can read and edit the project through its ordinary provider tools; the supplied diagnostics are untrusted context, not instructions.
The task does not replace the active conversation and can be opened from **View repair** when approval is needed.
Oversized batches are rejected explicitly rather than truncated (1000 diagnostics, 8 KiB per message, 1 MiB request body, and the provider's 120,000-character prompt limit).
Lattice temporarily disables editor writes while the repair runs and rejects repair in read-only projects.
Cancellation waits for a terminal provider state; switching projects cancels the outgoing repair and discards its late results.
Each click runs one repair attempt, with no automatic build-fix loop; remaining diagnostics stay visible after recompilation.

**Proofread** (the LaTeX selection toolbar, or ⌘⌥P) is a second user-initiated flow over the same relay.
Rust's `task_relay_request` relays `agent_text_task` to `/api/lattice/text-task` with the same start, status and cancel shape as compile repair:
`POST {workspaceRoot, prompt}` answers `202 {taskId}`, `GET …/<taskId>` answers `{status: "running" | "completed" | "failed", text?, message?}` with `text` the provider's answer, and `POST …/<taskId>/cancel` stops the task.
The fork answers on its auxiliary text-generation path with **Settings → Models → Proofreading model**, not as an Agent task: it creates no thread, and the provider is launched without tools, MCP servers or settings sources in an empty working directory, so it cannot edit a file or raise an approval. Lattice applies the result itself only after the writer accepts it.
The Proofreading model starts as "Same as Git writing", so it follows **Git writing model** until the writer picks one of the same choices; an override whose provider is disabled also falls back to the Git writing model.
Since `ac4900eaa`, the start answer and every status and cancel answer also carry `model: {provider, instanceId, slug, label, source}`, fixed when the task starts: `label` is the "Provider / Model" name Settings shows, and `source` is `"proofreading"` for an override or `"git-writing"` when inherited.
The field is additive; a runtime pinned before it omits `model`, so a reader must treat it as optional.
At most four text tasks run at once (429 beyond that), and an unknown task id is a JSON 404.
Lattice owns the prompts and the reply contract (`src/agent/agent-proofread.ts`): **Proofread** (⌘⌥P) makes only the smallest corrections to grammar, spelling and punctuation, and **Polish**, chosen from the toolbar or the card each time, also improves flow and clarity; both keep meaning, hedging, terminology, the spelling variant and every LaTeX construct, and answer between `<proofread>` markers, followed by one reason per change between `<reasons>` markers (`original words => revised words | category | note`, the category from a fixed list and the note in the interface language).
Lattice does not trust the reply to keep LaTeX intact: `src/agent/proofread-edits.ts` splits it into word-level edits, attaches each reason to the edit whose words it quotes (the card shows it as a tag), and holds back any edit that changes a protected span (`src/editor/latex/latex-protected.ts`: math, citation/reference/label commands and keys, `%` comments, command names, braces and options, environment boundaries, verbatim and paragraph breaks), and the card says so.
A status answer may carry an optional `model` string naming the model that answered; the card shows it when present. The pinned route does not send one yet.
A runtime without the route (one pinned before `fb759c3eb`) answers the router's bare 404. The relay reports that as `agent_route_unavailable`, and the card says the runtime cannot proofread yet.

**Annotation revisions** (the Annotations panel's "Revise from N annotations", or ⌘⇧↩ in an annotation's composer) run over the same relay, one text task per open annotation and at most three at once, so one slot stays free for Proofread.
Lattice owns the prompt and the reply contract (`src/agent/agent-annotations.ts`): the agent reads the writer's note, its intent, the annotated passage and the text around it, and answers with the revised passage between `<revision>` markers and its reason between `<reason>` markers, or with one `<question>` when it needs the writer first.
An "Add a citation" annotation also lists the bibliography's keys, and the agent may cite only those.
As with Proofread, nothing is written by the agent: `src/canvas/annotation-review.tsx` splits the revision into edits with `proofread-edits.ts`, holds back changes to protected LaTeX (citations are allowed when the note asks for one), and the writer accepts or rejects each proposal in the editor.

A conversation can answer an annotation too, through two host tools Lattice already handles as `synara:annotations-tool-request` / `lattice:annotations-tool-result` (`parseAgentAnnotationsToolRequest`): `propose_annotation_edit {annotation, edits: [{find, replace}], reason}` (each `find` occurs exactly once in the annotated passage) and `ask_about_annotation {annotation, question}`, where `annotation` is the pin number `read_editor_comments` now reports (`number`, `intent`, `status`, `question`, `pdfPage`).
The pinned runtime does not declare these tools yet; until a Synara pin adds them beside `read_editor_comments` (a native Lattice tool relayed through the shared host-tools poll, in `LATTICE_NATIVE_TOOL_NAMES`), proposals come only from the panel's revision rounds.

## Offline quality evaluation

Run `pnpm eval:agent` to replay the checked-in schema-version-1 research fixtures, or pass one or
more JSON/NDJSON trace paths after `--`. The harness correlates records by task and turn and exits
successfully only when every fixture's declared expected pass/fail outcome matches. It is entirely
offline: it does not contact a provider or the literature network. Vitest exercises individual
rules and malformed input in `scripts/agent-quality-eval.test.ts`, and grades every checked-in
fixture there too, so `pnpm check` and CI fail when a fixture stops matching its outcome.

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
- The preparation script builds the production web/server artifacts, downloads and verifies the official target-specific Node fallback, installs production dependencies except the Pi and OpenCode packages (see [Pi and OpenCode install on demand](#pi-and-opencode-install-on-demand)), and stages the result under `src-tauri/synara-runtime`.
- It strips the Node binary's local symbols (`strip -x`, kept: global symbols and the export trie that native addons bind through) and prunes what the server never loads: source maps, declarations, published TypeScript sources, other platforms' prebuilds, Shiki's grammars and themes (the server only parses patches; the build fails if it starts using `@pierre/diffs` for more), and KaTeX's woff/ttf fallbacks behind a woff2 source.
- Tauri's documented `TAURI_ENV_DEBUG` hook signal selects the package staging profile through `scripts/prepare-build.mjs`.
- Synara and Open Slide run on that standalone Node in every build (`src-tauri/src/sidecar.rs`).
- Claude sessions use the external `claude` executable selected in Provider settings (or found on
  the login-shell PATH). The SDK's otherwise bundled platform executable is replaced by a tiny PATH
  launcher so account probing follows the same installation without shipping a redundant copy.
- Tauri includes that directory through `bundle.resources`.

### Runtime size is a budget, not a note

Run `pnpm size:report` after preparing the runtimes and building the frontend to record exact file-byte totals for the web bundle, eager assets, Synara server and dependencies, presentation runtime, and provider executables.

The staged runtimes are **enforced**, not merely observed.
Both staging scripts prune through `scripts/lib/runtime-prune.mjs`: source maps, typings, tests, package docs, npm's `.bin` links, and binaries the target cannot load, never a file a `package.json` entry point names; Synara's also drops TypeScript sources, which Node will not load from `node_modules`.
`scripts/app-size-report.mjs` applies an uncompressed budget to Open Slide, and the Release workflow runs its `--app` mode on the built bundle, which prints the installed size per folder and fails above the installed-size ceiling.
It also fails if a staged Synara runtime lacks its standalone Node binary, or if the bundled Claude Agent SDK executable exceeds the 4 KiB PATH-launcher budget.
Read the current constants from that file rather than trusting a number quoted here; the recorded totals belong in the release notes for the version that measured them.

### Pi and OpenCode install on demand

The Pi (`@earendil-works/*`) and OpenCode (`@opencode/client`, `@opencode-ai/sdk`) packages are not in the bundle; with their dependency trees they were more than half of it.
The fork loads them through `apps/server/src/provider/providerRuntimes.ts`: from the server's own `node_modules` when present (a development checkout or standalone Synara), otherwise from an install under the agent data directory (`<app data>/synara/provider-runtimes/<runtime>/<lockfile hash>/`).
Until a runtime is installed, its provider reports `runtimeInstall: {status: "missing"}` and Settings → Providers, the model picker and the chat's provider banner offer a one-click install (`server.installProviderRuntime`); Claude and Codex do not depend on it.

The install downloads exactly the tarballs named by the fork's committed npm lockfile (`apps/server/providerRuntimes/<runtime>/package-lock.json`, whose root versions the preparation script checks against Synara's `bun.lock`) from the npm registry, rejects any whose bytes miss the lockfile's sha512 integrity, runs no package scripts, and keeps it only after a fresh Node process loads every module the server imports from it.
An interrupted or rejected install leaves nothing behind and can be retried; an installed runtime needs no network.
A new Synara pin that changes a lockfile asks for the install again.

## Syncing upstream

Before switching source checkouts, inspect `git status` in the checkout currently used by Lattice, including an explicit `SYNARA_SOURCE_DIR` override.
The pinned revision does not include uncommitted local patches or untracked regression tests.
Inventory those changes and preserve any intended fixes in the fork's history before moving the pin; do not silently discard or assume they were included in the upstream merge.
Keep the previous checkout available until the upgrade audit passes.

1. Fetch and merge the intended upstream release tag into **the branch named by `branch` in [`../scripts/synara-runtime.json`](../scripts/synara-runtime.json)**.
   The branch moves with each upstream version, so read it from the pin rather than from memory; older branches such as `codex/lattice-embed` still exist in the fork and are not what ships.
   Do not rewrite branch history.
   Tag a backup branch at the pre-merge commit first; the merge touches enough surface that a clean abort is worth having.
2. Prefer the host-profile seam for new work, and never reimplement an upstream tool handler. The
   fork modifies hundreds of upstream files, so expect real conflicts in `wsRpc.ts`, the contracts
   package, `GitCore.ts`, `providerMaintenance.ts`, and the chat components — merging is a review
   task, not a mechanical one.
3. Resolve conflicts hunk by hunk. Do not take one side wholesale for a whole file: our changes and
   upstream's frequently land in the same function, and conflict-block boundaries are often
   asymmetric, so a blanket `--theirs` can silently duplicate a function body.
4. Run `oxfmt --check`, then the workspace type checks, then the tests.
   Before changing the pin, run the Lattice browser regressions from the fork root (subject to the fork's `AGENTS.md` verification permissions):
   ```sh
   bun run --cwd apps/web test:browser -- src/components/ChatMarkdown.latticeIntegration.browser.tsx src/components/ChatMarkdown.tableLayout.browser.tsx src/components/chat/ComposerLatticeContextBar.browser.tsx src/components/chat/MessageTrail.browser.tsx
   ```
   The fork's `ChatView.browser.tsx` no longer has its `embedded sidebar` checks, so verify the narrow-panel behavior in the app instead. It must cover widening and shrinking the same mounted view, loaded and loading model controls, responsive history popups, and attachment minimums.
   Verify minimum-width reports against rendered geometry; unused toolbar space must remain compressible, without clipping the send control.
   A closed history menu must not reserve its preferred width, and Lattice must accept measured widths below its bootstrap minimum.
   Keep these regressions with the fork changes through merges; successful compilation alone does not verify Lattice's embedding behavior.
5. Start the staged server while another process owns port 3773; confirm it selects another
   loopback port and reports `startupReady`.
6. Commit the intended fork changes and update the exact revision in the local `scripts/synara-runtime.json`.
   Before publishing it, run `node scripts/check-synara-upgrade.mjs <previous-lattice-ref>`, using the Lattice commit or release tag from before the upgrade.
   The audit rejects dirty or untracked files in either checkout, a pin/HEAD mismatch, and missing ancestry from both the previous pin and the previous checkout's local HEAD.
   It requires full fork history and local access to the old checkout; it deliberately does not fetch, commit, discard, or publish anything.
   `SYNARA_SOURCE_DIR` overrides the new source location; `SYNARA_PREVIOUS_SOURCE_DIR` overrides the previous checkout's location when it differs from the old pin's `sourceDirectory`.
   Point the latter at the checkout previously used by Lattice, including any committed-but-unpinned fixes; both checkouts still must be clean and their history is checked.
   This is a local pre-publication check, not a replacement for browser regressions or a CI check that can see uncommitted files on another machine.
   CI's `synara-pin` job runs the published half on every pull request that moves the pin: `node scripts/check-synara-pin.mjs <base-lattice-ref>` fetches the fork's commits and fails unless the pin is on its declared `branch` and descends from the base's pin.
   Push the verified fork commit before publishing the Lattice pin.
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

- **Use the web workspace's test script: `bun run --cwd apps/web test`.**
  Its `vitest.config.ts` loads both the Vite/Lingui transforms and `vitest.setup.ts`, which installs in-memory `localStorage` and activates the test translation catalog.
  Running `vitest apps/web/src` with the root config bypasses those transforms, so PO imports and Lingui macros fail before the tests execute.
  Node 24+ exposes an experimental `localStorage` getter that resolves to `undefined` without `--localstorage-file`; keep the workspace setup so Zustand does not capture that missing value at import time.
- **Run the server and web suites sequentially.**
  `apps/server/src/provider/acp/AcpSdkConformance.test.ts` has a 90-second timeout that CPU
  contention will trip.

Generated runtime contents are intentionally ignored by Git. Only the pin, preparation script,
supervisor, integration UI, and documentation belong in the Lattice repository.
