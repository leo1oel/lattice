# Lattice architecture

Lattice is a local-first LaTeX/Markdown writing environment for macOS. This
document describes how the pieces fit together and which invariants are
load-bearing. It is written for a developer who has never seen the codebase.

For "where do I start when I want to change X", see
[`codebase-map.md`](codebase-map.md).

**About the `path:line` citations.** They were spot-checked against the working
tree, not exhaustively re-derived, and they drift with every commit — an earlier
revision of this document shipped several that were wrong on the day it was
written. Treat a line number as a pointer that gets you to the right
neighbourhood, not as a guarantee. File names, function names and constant names
are the durable anchors; if a line does not say what this document claims, grep
for the named symbol. Where a claim could not be verified from code it is marked
**(unverified)**.

---

## 1. Three processes

A running Lattice is three OS-level participants, not one:

```
┌──────────────────────────────────────────────────────────────────┐
│ Tauri host process (Rust)                                        │
│   src-tauri/src/main.rs → lib.rs::run()                          │
│   owns: filesystem, git, LaTeX build, Overleaf HTTP/socket.io,    │
│         SQLite FTS, TexLab, keychain, the sidecar's lifetime      │
│                                                                  │
│   ┌────────────────────────────────┐   ┌───────────────────────┐ │
│   │ WKWebView (React 19 + Vite)    │   │ Node sidecar (Synara) │ │
│   │   src/main.tsx → src/App.tsx   │   │ own process, own port │ │
│   │                                │   │ 127.0.0.1:<dynamic>   │ │
│   │   ┌──────────────────────────┐ │   │                       │ │
│   │   │ cross-origin <iframe>    │◄┼───┼── serves its own web  │ │
│   │   │ = the agent UI           │ │   │   UI over local HTTP  │ │
│   │   └──────────────────────────┘ │   │                       │ │
│   └────────────────────────────────┘   └───────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                                              │
                     subprocess: $LATTICE_BIN literature '<json>'
                                              ▼
                              same executable, headless run_cli() path
```

### 1.1 Webview ↔ Rust: Tauri `invoke` / `listen`

The webview calls Rust with `invoke("command_name", args)` against **157
registered commands** (see §2). Data flows the other way over Tauri events, of
which there are only **four** emitted from the project and editor layers:

| Event | Emitted in | Meaning |
| --- | --- | --- |
| `project-fs-changed` | `src-tauri/src/fs_watch.rs` | something under the project root changed on disk |
| `paper-import-progress` | `src-tauri/src/ipc/papers.rs` | streaming progress while importing a paper |
| `overleaf-realtime` | `src-tauri/src/ipc/overleaf_realtime.rs` | multiplexed Overleaf socket.io traffic (ops, presence, chat, comments, tracked changes) |
| `texlab-diagnostics` | `src-tauri/src/ipc/build.rs` | TexLab diagnostics published for the open `.tex` file, including updates long after the last edit |

`overleaf-realtime` is a single channel carrying **14** distinct
`RealtimeEvent::*` payload variants — the whole enum is in
`src-tauri/src/overleaf_rt/events.rs` (`Connected`, `ProjectJoined`,
`DocUpdate`, `OtError`, `DocAck`, `CommentAnchored`, `TreeChanged`,
`PresenceUpdated`, `PresenceLeft`, `ChangesAccepted`, `TrackChangesToggled`,
`ThreadsChanged`, `ChatMessage`, `Disconnected`). Four
different frontend hooks subscribe to it and filter by `type`
(`src/overleaf/use-overleaf-realtime.ts:499`, `src/overleaf/use-overleaf-presence.ts:86`,
`src/overleaf/use-overleaf-chat.ts:57`, `src/overleaf/use-overleaf-comments.ts:103`).
Rust addresses each window's events with `emit_to`, but Tauri still delivers
them to every untargeted listener, so subscribe only through
`onOverleafEvent` / `listenOverleafRealtime` (`src/overleaf/overleaf-realtime-listen.ts`),
which scope the listener to the current window — a bare `listen()` leaks one
window's Overleaf project into every other open window.

A fourth event, `trackpad-magnify`, is emitted from the macOS window layer
(`src-tauri/src/macos_window.rs`) and consumed at `src/pdf/use-pdf-zoom.ts:97`.

Every `listen()` call site follows the same cleanup shape (disposed flag +
unlisten race). Follow the existing pattern; the async `listen()` promise can
resolve after the effect has already been torn down.

### 1.2 Webview ↔ agent iframe: `postMessage`

The Synara agent UI is **not** a React component. It is the sidecar's own web
application, loaded into a cross-origin `<iframe>`:

- URL construction: `synaraFrameUrl()` at `src/agent/synara-runtime.ts:239`. It
  encodes `embed=1`, `workspaceRoot`, `theme`, `locale`, `surface`,
  `hostOrigin` and `section` as query params, and puts the auth token in the
  URL **fragment** (`#lattice-auth=…`, `src/agent/synara-runtime.ts:259`) so it never
  reaches a server log.
- Mount points: three `<iframe>` elements — the Agent panel
  (`src/trellis/trellis-agent-surface.tsx`), the source-control / review drawer
  (`src/app/app-history-drawers.tsx`), and the agent settings pane in
  `src/settings/synara-settings-pane.tsx`. The first two get their URLs from
  `src/app/app-synara-embed.ts`. All three use
  `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"`.
  Grep for `synaraFrameUrl`.
- Receiving: the `receive` handler in `useSynaraHost`
  (`src/app/use-synara-host.ts`). Every inbound message is checked against
  **both** `event.source === frameRef.current?.contentWindow` **and**
  `event.origin === origin` before being dispatched.
- Sending: `postMessage` from the same hook (App destructures it as
  `postSynaraMessage`), which is `frameRef.current?.contentWindow?.postMessage(...)`.

Because it is a separate origin in a separate process, agent token streaming
costs the React tree nothing — this is deliberate and is noted as a
"ruled out" cause in [`performance.md`](performance.md).

The protocol is a set of string-tagged message types, all prefixed `lattice:`.
The constants live next to the code that owns each concern rather than in one
file:

| Constant file | Messages |
| --- | --- |
| `src/agent/agent-host-context.ts:6-9` | `lattice:host-context`, `lattice:request-host-context`, `lattice:clear-host-context-selection` |
| `src/agent/synara-runtime.ts:25-27` | `lattice:project-history`, `lattice:restore-agent-checkpoint`, `lattice:agent-compile-result` |
| `src/agent/synara-confirmations.ts:6-7` | `lattice:confirmation-ack`, `lattice:confirmation-response` |
| `src/agent/agent-paper-library.ts:3-4` | `lattice:paper-library`, `lattice:request-paper-library` |
| `src/agent/agent-canvas-tools.ts:9` | `lattice:canvas-tool-result` |
| `src/agent/agent-spreadsheet-tools.ts:23` | `lattice:spreadsheet-tool-result` |
| `src/agent/agent-composer-files.ts:1` | `lattice:composer-files` |
| `src/app/use-synara-host.ts:22-25` | `lattice:request-agent-permission-mode`, `lattice:set-agent-permission-mode`, `lattice:agent-panel-opened`, `lattice:host-pointer` |
| `src/settings/synara-settings-pane.tsx:77` | `lattice:set-settings-section` |

`rg '"lattice:' src` enumerates the whole protocol in one pass.

Two properties of this boundary are worth internalising before you touch it:

1. **Inbound payloads are parsed, not trusted.** `parseAgentCompileResultMessage`
   (`src/agent/synara-runtime.ts:44`) and `parseAgentProjectHistorySnapshot`
   (`src/agent/synara-runtime.ts:149`) reject unknown keys, enforce bounded
   correlation-id shapes, and refuse absolute/`..`/scheme-prefixed paths.
   `synaraProjectRelativeFilePath` (`src/agent/synara-runtime.ts:202`) is the single
   funnel that turns an agent-supplied file reference into a project-relative
   path Lattice's file commands will accept.
2. **The host pushes context; the agent does not read the editor.**
   `buildAgentHostContext` (`src/agent/agent-host-context.ts:108`) snapshots the active
   surface (editor / pdf / paper), cursor position, and up to 12,000 characters
   of selection, and posts it as `lattice:host-context`.

### 1.3 Rust ↔ sidecar: spawn + loopback HTTP

`src-tauri/src/synara.rs` supervises the sidecar. It is a pull-based supervisor;
it emits **no** Tauri events, only two commands (`synara_ensure_ready`,
`synara_open_skills_folder`).

- Launch: `SynaraRuntime::spawn` runs the sidecar's Node — the standalone
  `synara-runtime/bin/node` in development, the bundled Chromium's Electron
  binary as Node in release builds (`chromium::NodeRuntime`) — against
  `synara-runtime/server/dist/index.mjs`, on the previous port when it is still
  free and otherwise with `--dynamic-port`, and `SYNARA_HOST=127.0.0.1`. On
  macOS the whole process tree runs inside `BIBLIOGRAPHY_SANDBOX_PROFILE`.
- Port discovery is out-of-band: Node writes
  `<SYNARA_HOME>/userdata/server-runtime.json` containing `{pid, origin}`
  (`RUNTIME_STATE_RELATIVE_PATH`). `wait_until_ready` polls that file every
  50 ms for up to 20 s, requires `pid` to match the child it spawned, then
  `GET {origin}/health` and checks `startupReady` (`health_is_ready`). The
  health client (like the repair client) comes from `http::loopback`, which
  skips proxies on purpose — a system `ALL_PROXY`
  otherwise makes a healthy loopback sidecar look dead until the timeout.
- Credentials: `SYNARA_AUTH_TOKEN` and `SYNARA_DESKTOP_SHUTDOWN_TOKEN` are each
  two concatenated UUIDv4s minted per spawn.
- Shutdown: the child leads its own process group, so
  `chromium::terminate_process_group` takes the whole tree with SIGTERM, a 2 s
  grace period, then SIGKILL. Two independent paths call it — `impl Drop for
  SynaraRuntime` and the `RunEvent::Exit` hook in `lib.rs`
  (`shutdown_child_runtimes`).
- Dev bypass: in debug builds only, `VITE_SYNARA_EMBED_URL` short-circuits the
  whole thing to an externally-run dev server with no child process and no auth
  token.

Ordinary writing sessions never start the sidecar. The first agent /
source-control / review / agent-settings surface calls `synara_ensure_ready`.

### 1.4 The fourth path: the app as its own subprocess

`lib.rs::run()` returns early when `agent_literature::run_cli()` handled the
invocation (only the macOS process-inspector hook runs before it). `run_cli()`
(`src-tauri/src/agent_literature.rs`) is a headless entry point that runs before
any Tauri or AppKit initialisation.

It handles exactly one argv subcommand — `literature` — and takes its real
input as a single JSON blob:

```console
$LATTICE_BIN literature '{"tool":"search_literature","params":{"query":"…"}}'
# with LATTICE_PROJECT_ROOT=<project dir> in the environment
```

The dispatcher is `enum LiteratureRequest` (`agent_literature.rs`,
`#[serde(tag = "tool", content = "params")]`) with **8** variants:
`search_literature`, `fetch_paper`, `list_papers`, `search_library`,
`fetch_web_reference`, `cite`, `upgrade_bibliography`, `remove_reference`.
Success prints JSON to stdout and exits 0; an error prints to stderr and exits
1; a bad payload or missing `LATTICE_PROJECT_ROOT` exits 2.

The caller is the sidecar. `SynaraRuntime::spawn` passes
`std::env::current_exe()` to the Node process as **`LATTICE_BIN`** — that single
line is the only occurrence of the name in the Rust tree; the consumer lives in
the packaged sidecar JavaScript, which is not in this repository.

Why it exists, per the module doc of `agent_literature.rs`: the agent runs in a
sidecar and cannot call Tauri commands, and reimplementing search/fetch/cite in
TypeScript would immediately drift from the UI's behaviour. Mutating tools use
`HistoryMode::Defer` so agent edits fold into the app's own transaction history
instead of committing independently.

[`synara-runtime.md`](synara-runtime.md) covers the other side of this call —
which tools reach the model, and under what names.

---

## 2. The Rust backend

`src-tauri/src/` is 117 Rust files and ~40k lines (tests included). `main.rs` is
a 6-line shim; all the work starts in `lib.rs::run()`. Large areas follow the
2018 module layout: a short `x.rs` that maps the area (module docs, the `mod`
list, the few re-exports other code uses) beside an `x/` directory holding the
parts — `project/`, `overleaf/`, `overleaf_rt/`, `papers/`, `citation_audit/`,
`latex/`, `tex_setup/`, `browser_host/`, `synara/`, `commands/`, `git/`,
`ipc/`.

### 2.1 `lib.rs` wires; `ipc/` handles; domain modules decide

`lib.rs` (~500 lines) declares the modules, sets up plugins, the window
lifecycle and the child runtimes, and registers **157** commands in
`tauri::generate_handler!`. Every `#[tauri::command]` in the tree is
registered, and every registered command has a caller in `src/`.

The command handlers live in `src-tauri/src/ipc/`, one module per area of the
app (`workspace`, `files`, `history`, `search`, `build`, `git`, `bibliography`,
`papers`, `overleaf`, `overleaf_realtime`, `windows`). A handler is a thin
shell: resolve the calling window's project (`ipc::current_root`, or
`pinned_root` / `scoped_root` when the request names the project it was made
for), take the project lease the operation needs (`AppState::lease`), and run
the domain call on the blocking pool (`ipc::run_blocking` / `in_project`).
Behaviour belongs in the domain modules. A few self-contained services keep
their commands beside their state: `synara.rs`, `presentation.rs`,
`browser_host.rs`, `literature_credentials.rs`, `link_preview.rs`,
`diagnostic_logs.rs`, `macos_window.rs`.

Which project each window shows, and the per-project resources that must not be
shared between windows (the active build, the TexLab pool, the Overleaf
channel, the file watcher), live in `app_state.rs`.

Practical consequence: to find what a button does, grep the command name in
`src-tauri/src/ipc/` (or the service module), then follow the one call it makes.

### 2.2 Commands by area

| `ipc` module | Commands | Examples |
| --- | --- | --- |
| `overleaf` + `overleaf_realtime` | 42 | `overleaf_status`, `overleaf_clone_project`, `overleaf_sync`, `overleaf_rt_connect`, `overleaf_rt_send_ops` |
| `files` | 21 | `read_project_file`, `write_project_file`, `create_project_entry`, `move_project_entry` |
| `build` | 17 | `build_project`, `abort_build`, `synctex_edit`, `texlab_diagnostics`, `start_tex_install`, `run_doctor` |
| `search` | 11 | `search_project`, `replace_in_project`, `rename_label`, `list_todos` |
| `windows` | 9 | `open_project_window`, `open_paper_lookup`, `restart_after_update`, `set_window_background` |
| `bibliography` | 13 | `list_citation_keys`, `save_bib_entry`, `bibliography_audit_scan`, `agent_bibliography_mutation` |
| `workspace` | 10 | `create_project`, `open_project`, `import_project_zip`, `update_project_manifest` |
| `papers` | 10 | `search_literature`, `fetch_paper`, `import_reference`, `read_paper` |
| `git` | 7 | `git_status`, `git_log`, `git_show_diff`, `git_restore_project`, `git_auto_commit` |
| `history` | 5 | `list_history`, `get_history_entry`, `revert_transaction` |
| service modules | 14 | `synara_ensure_ready`, `presentation_ensure_ready`, `set_literature_credential`, `link_preview`, `collect_diagnostic_logs` |

Overleaf alone is a quarter of the IPC surface — still the single most
surprising fact about this backend.

### 2.3 Hubs, leaves, and cycles

Sizes by area (lines, tests included): `project` ~6.3k · `papers` ~4.8k ·
`overleaf` ~4.2k · `citation_audit` ~3.3k · `overleaf_rt` ~3.0k · `ipc` ~2.5k ·
`latex` ~1.5k · `browser_host` ~1.3k · `tex_setup` ~1.0k · everything else
under 1,000.

**Hubs** (by number of modules that depend on them):

- `project` — project validation, the transaction/history model, file
  classification, the tree, path safety, bibliography sources.
- `commands` — the base process layer (resolving and spawning external tools
  the way a GUI-launched app has to, plus the pinned Python CLIs). No intra-crate
  dependencies beyond credentials for those CLIs. Safe to read first.
- `models` — shared serde types crossing the IPC boundary.
- `util` / `test_support` — shared text/hash helpers and the unit tests' temp
  directory fixture.

**Leaves** include `firecrawl`, `harper`, `link_preview`, `pdf_fonts`, `xlsx`
and `macos_window`.

**Mutual dependencies:**

| Pair | Verdict |
| --- | --- |
| `project` ↔ `project_fs` | **Real cycle in production code.** `project` uses `ProjectDir` for checked writes; `project_fs` calls back into `crate::project` for path safety and history pruning. |
| `fts` ↔ `project` | **Real cycle in production code.** The index reads project files through `project`; `project/search.rs` and `project/history.rs` call `crate::fts::{search, update_paths}`. |
| `overleaf` ↔ `overleaf_rt` | **Not a runtime cycle.** `overleaf/` depends on `overleaf_rt` (comment ranges, URL encoding, permissions); the only reverse references are in `overleaf_rt/tests.rs`, which the ignored live tests under `overleaf/` share. |

### 2.4 Overleaf, specifically

`overleaf_rt` is a hand-written **Socket.IO 0.9** client, because Overleaf
ships `socket.io-client 0.9.17-overleaf-5` and the wire protocol is the legacy
`{type}:{id}:{endpoint}:{data}` framing, not Engine.IO v4. The module header of
`overleaf_rt.rs` documents the handshake, upgrade, framing and the exact frames
Lattice emits, pinned against the Overleaf-Workshop VS Code extension. Read
that header before changing anything under `overleaf_rt/`.

`overleaf` handles the non-realtime side: login/session (`overleaf/account.rs`,
`overleaf-session.json` in app data), linking and clone (`overleaf/link.rs`),
the REST API (`overleaf/api.rs`), history and review (`overleaf/review.rs`),
and a real three-way merge (`overleaf/sync.rs`). The merge keeps a pristine copy of every text file as of
the last sync under `.research/overleaf-base/` (`overleaf/files.rs`) — that is
the common ancestor without which only "both sides changed" could be detected,
never how to combine. Files with conflict markers are refused for upload
(`CONFLICT_MARKER`). Files above 45 MB are reported rather than synced
(`MAX_SYNC_FILE_BYTES`).

---

## 3. On-disk data model

A Lattice project is an ordinary folder. Everything Lattice adds lives under
`.research/`. `prepare_project_skeleton` (`src-tauri/src/project/create.rs`)
creates it.

| Path | Owner | Contents |
| --- | --- | --- |
| `.research/project.json` | `project/manifest.rs` (`MANIFEST_PATH`) | project manifest: name, venue, root documents, spelling words |
| `.research/brief.md` | `project/create.rs` | the project brief shown in the sidebar |
| `.research/papers/<arxivId>/` | `papers/` | imported papers: `paper.md`, `blog.md`, `metadata.json`, `paper_assets/` |
| `.research/history/<id>.json` | `project/history.rs` | transaction history records (schema v2, `HISTORY_SCHEMA_VERSION`); capped at 100 (`MAX_HISTORY_ENTRIES`) |
| `.research/sessions/` | `project/create.rs` | agent session records |
| `.research/checkpoints/` | agent runtime | turn checkpoints; capped at 100 per session / 256 MB (`project/history.rs`) |
| `.research/cache/` | various | `fts.sqlite` (full-text index), `citation-health-v1.json` |
| `.research/licenses/` | `project/create.rs` | license texts for imported material |
| `.research/overleaf.json` | `overleaf/link.rs` | Overleaf link state: project id, file hashes, sync mode |
| `.research/overleaf-base/` | `overleaf/files.rs` (`BASE_DIR`) | pristine copies of every synced text file — the merge base for three-way sync |
| `.research/editor-comments.json` | `project/manifest.rs` (`EDITOR_COMMENTS_PATH`) | editor comment threads |
| `.research/pdf-annotations.json` | — | PDF annotations from older builds; no longer read or written |
| `.research/tutorial.json` | `project/create.rs` | tutorial-project state |
| `.research/omp-*` | agent runtime | agent runtime scratch; excluded from export and from agent reads |

The Overleaf session cookie is **not** in the project — it lives in app data
(`overleaf-session.json`, `overleaf/account.rs`).

Two gitignore files are written at project creation (`project/create.rs`):
`.research/.gitignore` contains `history/ sessions/ checkpoints/ cache/`
(`RESEARCH_GITIGNORE`), and the project's root `.gitignore`
gets the same four paths plus `/main.pdf` and the LaTeX build-artifact list.
Every open (`project/manifest.rs`) writes `.research/.gitignore` only if it is
missing (an existing one is left as is), and `ensure_ignore_line` adds
`.research/checkpoints/`, `.research/cache/` and the build-artifact list to the
root `.gitignore`. That covers folders Lattice did not create; otherwise the first commit would adopt every
`.log` and `.fls` in the directory.

Export (`export_project_zip`) excludes `.git/`, `.research/history`,
`sessions`, `omp-*`, `checkpoints`, `cache`, and the usual TeX artifacts
(`EXPORT_EXCLUDED_DIRS` and
`EXPORT_EXCLUDED_SUFFIXES` in `project/archive.rs`). Raw byte writes
(`write_project_bytes`, used by Open Slide) refuse history, sessions, `omp-*`,
checkpoints, cache and paper bundles (`UNSYNCED_RESEARCH_PREFIXES` in
`project/imports.rs`).

---

## 4. Performance and bundle constraints

These are deliberate. Breaking one regresses cold start for every user, and the
regression is not visible in a dev build.

### 4.1 The eager-startup JavaScript budget

`pnpm build` is `tsc && vite build && node scripts/app-size-report.mjs --check`
(`package.json:9`). The `--check` pass enforces four budgets, all in
`scripts/app-size-report.mjs:158-161`:

| Budget | Value | Constant |
| --- | --- | --- |
| Eager JavaScript (all `<script>` in `index.html`) | `1.35 * 1024 * 1024` = 1,415,577 bytes | `EAGER_JS_BUDGET_BYTES` |
| Eager `rolldown-runtime` chunk | 4 KiB | `ROLLDOWN_RUNTIME_BUDGET_BYTES` |
| Bundled Claude executable (must stay a PATH launcher) | 4 KiB | `CLAUDE_PATH_LAUNCHER_BUDGET_BYTES` |
| macOS Synara runtime resource | 250 MiB | `MACOS_SYNARA_RUNTIME_BUDGET_BYTES` |

The check additionally refuses any external (non-local) eager script
(`app-size-report.mjs:176`), any unexpected eager asset (`:186`), anything other
than exactly one of each named eager chunk (`:195`), and more than one
rolldown-runtime chunk (`:200`). The application-owned eager chunks are `app`
and `ui`. The production build has a single html entry (`vite.config.ts`), so a
third eager chunk means the module grouping changed and the allowlist should be
re-derived rather than widened.

Heavy libraries must stay behind dynamic imports: pdfjs, mermaid, katex,
the CodeMirror language packs, TipTap, Univer, tldraw.

`src/canvas/canvas-lazy-modules.ts` is the canonical example of how to do this, and
its header explains a subtlety worth repeating: **each loader is the identity of
a chunk**. Import the loader; do not inline `import("./pdf-viewer")` at a call
site, or that site gets its own copy of the module graph in a second chunk.

### 4.2 Never value-import `tldraw` from an eagerly-loaded module

`tldraw`'s barrel has no `sideEffects` flag, so a single value import drags
~1.5 MB plus prosemirror into the startup chunk. The whiteboard lives behind
`loadBoardEditorModule()` (`src/canvas/canvas-lazy-modules.ts:28`), and the
agent-facing adapter is isolated in `src/agent/agent-canvas-tldraw-adapter.ts` so that
`src/agent/agent-canvas-tools.ts` can register it without importing tldraw itself.

Non-test value importers of `tldraw` today: `src/editor/board/board-editor.tsx`,
`src/editor/board/board-store.ts`, `src/editor/board/board-asset-urls.ts`,
`src/agent/agent-canvas-tldraw-adapter.ts` — all reachable
only through the lazy board chunk.

**This rule is not lint-enforced.** There is no `no-restricted-imports` entry
for it in `eslint.config.js`. The only backstop is the eager-JS budget, which
fails the build after the fact. Treat it as a convention you must uphold by
hand.

### 4.3 The shiki grammar allowlist

`vite.config.ts:21` defines `shikiTrimPlugin`, which stubs every
`@shikijs/langs` and `@shikijs/themes` module outside an allowlist.

- Kept languages (`vite.config.ts:25-40`): `tex`, `bibtex`, `markdown` (for the
  Pierre diff views in `src/history/file-diff-view.tsx`), plus `vue`, `tsx`, `svelte`,
  `typescript`, `javascript`, `bash`, `json`, `yaml`, `astro`.
- Kept themes (`:41-48`): `github-light`, `github-dark`,
  `material-theme-lighter`, `material-theme-palenight`.
- The plugin then walks the *transitive* closure of static grammar imports
  (`:56-71`) — `vue` pulls `html`, `css`, and so on — so embedded regions keep
  their rules.
- Stubbed modules are ~100 bytes each; they are folded into one `shiki-stubs`
  chunk (`:124-126`) to avoid emitting ~450 near-empty asset files.

**The allowlist is currently over-broad.** The nine non-TeX languages and the
two `material-theme-*` themes were kept for `comark`, which has since been
removed — it is no longer in `package.json` and survives only in the stale
comments at `vite.config.ts:13,17,30,45`. The single runtime consumer of shiki
today is `src/history/file-diff-view.tsx`, which statically imports exactly
`@shikijs/langs/{tex,bibtex,markdown}` and `@shikijs/themes/{github-light,github-dark}`
and clamps every diff to one of those three languages
(`pierreLanguageForPath`, `src/history/file-diff-view.tsx:42-45`). Trimming `vue`,
`tsx`, `svelte`, `typescript`, `javascript`, `bash`, `json`, `yaml`, `astro`,
their transitive closure, and the two material themes is available bundle
savings that nobody has taken. It is safe as-is — over-keeping only costs size.

**If new code can highlight a language at runtime, add it to `keepLangs`.**
Otherwise it silently renders unhighlighted.

### 4.4 `panic = "abort"` is deliberately off

`src-tauri/Cargo.toml:31-35`:

```toml
[profile.release]
codegen-units = 16
lto = false
opt-level = "s"
strip = "symbols"
```

`panic = "abort"` is **not** present as a key, commented out or otherwise. It
appears only in the prose comment at `Cargo.toml:24`:

> `panic="abort"` would save ~3 MB more but turns any panic into a hard crash
> with unsaved editor state on screen, so it stays off.

This pairs with the panic hook installed by `std::panic::set_hook` in
`lib.rs::run()`, which logs to `lattice::panic` — and only works because panics
unwind.

Two notes on the rest of the profile:

- The comment at `Cargo.toml:28` says "thin LTO across 16 units", but the actual
  setting is `lto = false`, which in Cargo means thin-*local* LTO within each
  codegen unit — **not** `lto = "thin"` cross-crate ThinLTO. The comment is
  misleading; the effective setting is no cross-crate LTO.
- The measured effect of the profile as a whole: 26.6 MB → 12.9 MB on
  aarch64-darwin (`Cargo.toml:23`).

There are no other `[profile.*]` sections and no per-package overrides.

---

## 5. The design-system contract

Palette and spacing decisions are enforced by tests, not by review.

Layout: `src/App.css` is a 10-line import manifest for `src/styles/`:
`foundations.css` (496 lines — the token scale), `surfaces.css`, `theme.css`
(142 — the palette), `app-shell.css`, `editor-workspace.css` (2,036),
`workspace-panels.css`, `dialogs.css`, `adaptive-feedback.css`.
`src/index.css` layers Tailwind v4 **without** preflight and maps shadcn's
colour names onto the app's own theme variables.

`src/styles/tokens.test.ts` (325 lines, 14 cases) fails the build when:

- a palette token (`--bg`, `--text`, …) is referenced outside theme/foundations
  (`:98`);
- a semantic role is mapped onto the palette in more than one place (`:108`);
- a referenced custom property resolves nowhere (`:116`);
- spacing uses a raw px value that is on the scale instead of `var(--space-*)`
  (`:226`);
- motion durations, interface type sizes, or nested radii bypass their shared
  scales (`:247`, `:267`, `:281`);
- `!important` is used outside surfaces the app does not own (`:307`);
- host CSS leaks into the embedded Synara document (`:330`).

There are also cross-component consistency cases: one height across the
navigation controls (`:140`), one action width across sidebar modes (`:146`),
28px compact / 30px default single-line controls (`:153`), one typography
contract for Settings controls (`:161`), one focus ring drawn exactly once
(`:200`).

`src/styles/surfaces.test.ts` (216 lines) covers the surface layer.

Run them without the full gate:

```console
pnpm vitest run src/styles/tokens.test.ts
pnpm vitest run src/styles/surfaces.test.ts
```

The reasoning behind the density and typography choices is in
[`design-system.md`](design-system.md).

---

## 6. The gate

```console
pnpm check     # = mise run check
```

`mise.toml`'s `check` task depends on ten stages that run in parallel, each
skipped when its declared `sources` have not changed (`[tasks.check]`):
`i18n-check`, `lint`, `test`, `build`, `literature-worker`,
`open-slide-runtime`, `cargo-fmt`, `cargo-test`, `clippy`, `notices`. It needs [mise](https://mise.jdx.dev).

CI (`.github/workflows/ci.yml`) covers the same ground across five jobs:
`test`, `literature-worker` (`typecheck` + `test` in that sub-project),
`open-slide-runtime` (`test` in `tools/open-slide-runtime`),
`lint-and-build` (`pnpm lint`, `pnpm build`, `pnpm i18n:check`,
`pnpm notices:check`) and `rust`
(`cargo fmt --check`, `cargo test`, `cargo clippy -D warnings`). A sixth job,
`perf-bench`, runs the interaction benchmark (`pnpm perf:bench --check`,
`mise run perf-bench` locally), which `check` leaves out; see
[`performance.md`](performance.md).

`pnpm lint` runs ESLint with the `--max-warnings` cap set in the `lint` script
in `package.json`. That cap is a debt ratchet:
lower it when you remove warnings, never raise it.

Testing environment: Vitest + jsdom, 20 s test timeout
(`vitest.config.ts:70`), `literature-worker/**` and `.tmp/**` excluded
(`vitest.config.ts:61`). `App.test.tsx` renders the real `App` with a mocked
`invoke`, and startup ordering matters: the
backend's `initial_project` (`ipc/workspace.rs`; see `initialProjectProbe` in
`src/App.tsx`) must beat the recent-project auto-reopen.

CI runners are slow. Avoid tests that assume nothing re-renders between two
events; async highlight and render passes can land in between.
