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

The webview calls Rust with `invoke("command_name", args)` — about 258 call
sites in `src/` against **166 registered commands** (see §2). Data flows the
other way over Tauri events, of which there are only **three** emitted from
Rust:

| Event | Emitted at | Meaning |
| --- | --- | --- |
| `project-fs-changed` | `src-tauri/src/fs_watch.rs:147` | something under the project root changed on disk |
| `paper-import-progress` | `src-tauri/src/lib.rs:3289` | streaming progress while importing a paper |
| `overleaf-realtime` | `src-tauri/src/lib.rs:2282` | multiplexed Overleaf socket.io traffic (ops, presence, chat, comments, tracked changes) |

`overleaf-realtime` is a single channel carrying **14** distinct
`RealtimeEvent::*` payload variants — the whole enum is
`src-tauri/src/overleaf_rt.rs:114-211` (`Connected`, `ProjectJoined`,
`DocUpdate`, `OtError`, `DocAck`, `CommentAnchored`, `TreeChanged`,
`PresenceUpdated`, `PresenceLeft`, `ChangesAccepted`, `TrackChangesToggled`,
`ThreadsChanged`, `ChatMessage`, `Disconnected`). Four
different frontend hooks subscribe to it and filter by `type`
(`src/overleaf/use-overleaf-realtime.ts:643`, `src/overleaf/use-overleaf-presence.ts:90`,
`src/overleaf/use-overleaf-chat.ts:114`, `src/overleaf/use-overleaf-comments.ts:151`).

A fourth event, `trackpad-magnify`, is emitted from the macOS window layer
(`src-tauri/src/macos_window.rs`) and consumed at `src/pdf/pdf-viewer.tsx:916`.

Every `listen()` call site follows the same cleanup shape (disposed flag +
unlisten race). Follow the existing pattern; the async `listen()` promise can
resolve after the effect has already been torn down.

### 1.2 Webview ↔ agent iframe: `postMessage`

The Synara agent UI is **not** a React component. It is the sidecar's own web
application, loaded into a cross-origin `<iframe>`:

- URL construction: `synaraFrameUrl()` at `src/agent/synara-runtime.ts:258`. It
  encodes `embed=1`, `workspaceRoot`, `theme`, `locale`, `surface`,
  `hostOrigin` and `section` as query params, and puts the auth token in the
  URL **fragment** (`#lattice-auth=…`, `src/agent/synara-runtime.ts:278`) so it never
  reaches a server log.
- Mount points: three `<iframe>` elements — the agent sidebar and the
  source-control / review drawer in `src/App.tsx`, and the agent settings pane
  in `src/settings/settings-dialog.tsx`. All three use
  `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"`.
  Grep for `synaraFrameUrl`.
- Receiving: the `receiveSynaraMessage` handler in `src/App.tsx`. Every inbound
  message is checked against **both**
  `event.source === synaraIframeRef.current?.contentWindow` **and**
  `event.origin === synaraOrigin` before being dispatched.
- Sending: `postSynaraMessage` in `src/App.tsx`, which is
  `synaraIframeRef.current?.contentWindow?.postMessage(...)`.

Because it is a separate origin in a separate process, agent token streaming
costs the React tree nothing — this is deliberate and is noted as a
"ruled out" cause in [`performance.md`](performance.md).

The protocol is a set of string-tagged message types, all prefixed `lattice:`.
The constants live next to the code that owns each concern rather than in one
file:

| Constant file | Messages |
| --- | --- |
| `src/agent/agent-host-context.ts:4-7` | `lattice:host-context`, `lattice:request-host-context`, `lattice:clear-host-context-selection` |
| `src/agent/synara-runtime.ts:23-25` | `lattice:project-history`, `lattice:restore-agent-checkpoint`, `lattice:agent-compile-result` |
| `src/agent/synara-confirmations.ts:5-6` | `lattice:confirmation-ack`, `lattice:confirmation-response` |
| `src/agent/agent-paper-library.ts:3-4` | `lattice:paper-library`, `lattice:request-paper-library` |
| `src/agent/agent-canvas-tools.ts:8` | `lattice:canvas-tool-result` |
| `src/agent/agent-spreadsheet-tools.ts:13` | `lattice:spreadsheet-tool-result` |
| `src/agent/agent-composer-files.ts:1` | `lattice:composer-files` |
| `src/App.tsx` (module scope) | `lattice:request-agent-permission-mode`, `lattice:set-agent-permission-mode`, `lattice:agent-panel-opened`, `lattice:host-pointer` |
| `src/settings/settings-dialog.tsx:81` | `lattice:set-settings-section` |

`rg '"lattice:' src` enumerates the whole protocol in one pass.

Two properties of this boundary are worth internalising before you touch it:

1. **Inbound payloads are parsed, not trusted.** `parseAgentCompileResultMessage`
   (`src/agent/synara-runtime.ts:40`) and `parseAgentProjectHistorySnapshot`
   (`src/agent/synara-runtime.ts:167`) reject unknown keys, enforce bounded
   correlation-id shapes, and refuse absolute/`..`/scheme-prefixed paths.
   `synaraProjectRelativeFilePath` (`src/agent/synara-runtime.ts:221`) is the single
   funnel that turns an agent-supplied file reference into a project-relative
   path Lattice's file commands will accept.
2. **The host pushes context; the agent does not read the editor.**
   `buildAgentHostContext` (`src/agent/agent-host-context.ts:90`) snapshots the active
   surface (editor / pdf / paper), cursor position, and up to 12,000 characters
   of selection, and posts it as `lattice:host-context`.

### 1.3 Rust ↔ sidecar: spawn + loopback HTTP

`src-tauri/src/synara.rs` supervises the sidecar. It is a pull-based supervisor;
it emits **no** Tauri events, only three commands
(`synara_runtime_status`, `synara_ensure_ready`, `synara_open_skills_folder`,
`synara.rs:352-365`).

- Launch: `SynaraRuntime::spawn` (`synara.rs:254`) runs the **bundled** Node
  binary (`synara-runtime/bin/node`, `synara.rs:139`) against
  `synara-runtime/server/dist/index.mjs` (`synara.rs:140`) with
  `--dynamic-port` and `SYNARA_HOST=127.0.0.1` (`synara.rs:291,295`).
- Port discovery is out-of-band: Node writes
  `<SYNARA_HOME>/userdata/server-runtime.json` containing `{pid, origin}`
  (`synara.rs:16,70`). `wait_until_ready` (`synara.rs:397`) polls that file every
  50 ms for up to 20 s, requires `pid` to match the child it spawned, then
  `GET {origin}/health` and checks `startupReady` (`health_is_ready`,
  `synara.rs:506-518`). The health
  client is built `.no_proxy()` on purpose — a system `ALL_PROXY` otherwise
  makes a healthy loopback sidecar look dead until the timeout.
- Credentials: `SYNARA_AUTH_TOKEN` and `SYNARA_DESKTOP_SHUTDOWN_TOKEN` are each
  two concatenated UUIDv4s minted per spawn (`synara.rs:285-286`).
- Shutdown: on Unix the child leads its own process group
  (`command.process_group(0)`, `synara.rs:322`) so `kill(-pgid, SIGTERM)` takes
  the whole tree (`terminate_process_tree`, `synara.rs:529`), with a 2 s grace
  period. Two independent
  paths call it — `impl Drop` (`synara.rs:346`) and the `RunEvent::Exit` hook at
  `lib.rs:3962`.
- Dev bypass: in debug builds only, `VITE_SYNARA_EMBED_URL` short-circuits the
  whole thing to an externally-run dev server with no child process and no auth
  token (`synara.rs:109-116`).

Ordinary writing sessions never start the sidecar. The first agent /
source-control / review / agent-settings surface calls `synara_ensure_ready`.

### 1.4 The fourth path: the app as its own subprocess

`lib.rs::run()`'s **first statement** is `if run_cli() { return; }`
(`lib.rs:3726-3727`). `run_cli()` (`lib.rs:3662`) is a headless entry point that
runs before any Tauri or AppKit initialisation.

It handles exactly one argv subcommand — `literature` — and takes its real
input as a single JSON blob:

```console
$LATTICE_BIN literature '{"tool":"search_literature","params":{"query":"…"}}'
# with LATTICE_PROJECT_ROOT=<project dir> in the environment
```

The dispatcher is `enum LiteratureRequest` (`lib.rs:3631`,
`#[serde(tag = "tool", content = "params")]`) with **8** variants:
`search_literature`, `fetch_paper`, `list_papers`, `search_library`,
`fetch_web_reference`, `cite`, `upgrade_bibliography`, `remove_reference`.
Success prints JSON to stdout and exits 0; an error prints to stderr and exits
1; a bad payload or missing `LATTICE_PROJECT_ROOT` exits 2
(`lib.rs:3667-3678, 3711-3723`).

The caller is the sidecar. `synara.rs:307-311` passes
`std::env::current_exe()` to the Node process as **`LATTICE_BIN`** — that single
line is the only occurrence of the name in the Rust tree; the consumer lives in
the packaged sidecar JavaScript, which is not in this repository.

Why it exists, per the doc comment at `lib.rs:3619-3628`: the agent runs in a
sidecar and cannot call Tauri commands, and reimplementing search/fetch/cite in
TypeScript would immediately drift from the UI's behaviour. Mutating tools use
`HistoryMode::Defer` (`lib.rs:3699,3703,3707`) so agent edits fold into the
app's own transaction history instead of committing independently.

[`synara-runtime.md`](synara-runtime.md) covers the other side of this call —
which tools reach the model, and under what names.

---

## 2. The Rust backend

`src-tauri/src/` is 31 files and ~38.4k lines. `main.rs` is a 6-line shim; all
the work starts in `lib.rs::run()` (`lib.rs:3726`).

### 2.1 `lib.rs` is an IPC facade, not a domain layer

`lib.rs` declares all 29 modules and registers **166** commands in
`tauri::generate_handler!` (`lib.rs:3792-3959`). There are also exactly 166
`#[tauri::command]` attributes in the tree, so **no command is defined but
unregistered**.

159 of those 166 are defined *in `lib.rs` itself*, as thin wrappers that
validate arguments and delegate into a domain module. Only three modules export
commands directly: `synara.rs` (3), `collab_credentials.rs` (3),
`link_preview.rs` (1). `project.rs`, `overleaf.rs`, `papers.rs`, `git.rs`,
`latex.rs` and the rest contain **zero** `#[tauri::command]` attributes.

Practical consequence: to find what a button does, grep the command name in
`lib.rs`, then follow the one call it makes.

### 2.2 Commands by domain

Grouped rather than enumerated (166 is too many to read):

| Domain | ≈count | Examples |
| --- | --- | --- |
| Overleaf (incl. 10 realtime `overleaf_rt_*`) | 48 | `overleaf_status`, `overleaf_clone_project`, `overleaf_rt_connect`, `overleaf_rt_send_ops`, `overleaf_history_diff` |
| Project file I/O and tree ops | 16 | `read_project_file`, `write_project_file`, `create_project_entry`, `move_project_entry`, `watch_project` |
| Git versioning | 15 | `git_status`, `git_commit`, `git_push`, `git_show_diff`, `git_restore_project` |
| Papers / OpenAlex / literature | 14 | `search_openalex`, `search_literature`, `fetch_paper`, `import_reference`, `upgrade_bibliography` |
| Search and refactor (FTS + semantic) | 11 | `search_project`, `semantic_search_project`, `replace_in_project`, `rename_label`, `rename_citation_key` |
| Project lifecycle and windows | 9 | `create_project`, `open_project`, `open_project_window`, `import_project_zip`, `refresh_project` |
| LaTeX build and PDF | 8 | `build_project`, `abort_build`, `clean_project`, `synctex_edit`, `read_compiled_pdf` |
| Bibliography (`.bib` editing) | 6 | `list_citation_keys`, `read_bib_entry`, `save_bib_entry`, `resolve_citation_query` |
| TexLab / LSP and linting | 6 | `texlab_diagnostics`, `texlab_completion`, `texlab_hover`, `format_latex`, `harper_lint` |
| Collaboration and sharing | 5 | `put_collab_credential`, `create_collab_join_workspace`, `collab_project_inventory_v2` |
| Lattice transaction history | 5 | `list_history`, `get_history_entry`, `revert_transaction`, `revert_history_file` |
| Project manifest / settings | 4 | `update_project_manifest`, `add_root_document`, `set_project_spelling_words` |
| Annotations and editor comments | 4 | `list_pdf_annotations`, `save_pdf_annotations`, `list_editor_comments` |
| Misc (logs, link preview, xlsx) | 4 | `link_preview`, `get_app_log_dir`, `save_xlsx` |
| Synara sidecar | 3 | `synara_runtime_status`, `synara_ensure_ready`, `synara_open_skills_folder` |
| Document analysis | 3 | `list_unused_symbols`, `list_todos`, `count_project_words` |
| macOS window chrome | 3 | `set_window_background`, `align_traffic_lights`, `sample_screen_color` |
| TeX toolchain install | 2 | `start_tex_install`, `start_tex_dependency_install` |

Overleaf alone is 29% of the IPC surface; Overleaf plus git is 38%. That ratio
is the single most surprising fact about this backend.

### 2.3 Hubs, leaves, and the two real cycles

Sizes: `project.rs` 8,093 · `overleaf.rs` 4,955 · `overleaf_rt.rs` 4,389 ·
`lib.rs` 3,993 · `papers.rs` 3,474 · `semantic_search.rs` 1,690 · `git.rs`
1,477 · `latex.rs` 1,320 · `tex_setup.rs` 1,291 · `fts.rs` 1,005 · everything
else under 1,000.

**Hubs** (by number of modules that depend on them):

- `project.rs` — 10 dependents. Project validation, the transaction/history
  model, file classification, the tree, path safety. Also the largest file.
- `commands.rs` — 9 dependents, **0 dependencies**. The base utility layer
  (process spawning, environment/PATH resolution). Safe to read first.
- `models.rs` — 10 dependents. Shared serde types crossing the IPC boundary.
- `openalex.rs` — 4 dependents (`alphaxiv`, `citation_health`, `literature`,
  `papers`).

**Leaves** (no intra-crate dependencies): `collab_credentials.rs`,
`commands.rs`, `firecrawl.rs`, `harper.rs`, `link_preview.rs`, `pdf_fonts.rs`,
`semantic_search.rs`, `synara.rs`, `xlsx.rs`, `macos_window.rs`.
`semantic_search.rs` is an outlier: 1,690 lines with neither in- nor out-edges,
reachable only through its four commands in `lib.rs`.

**Mutual dependencies.** Two of the three pairs commonly cited are real; one is
not:

| Pair | Verdict |
| --- | --- |
| `project.rs` ↔ `project_fs.rs` | **Real cycle in production code.** `project.rs:9` imports `ProjectDir`; `project_fs.rs:282,286,287,291,299` call back into `crate::project::{creation_path, safe_path, prune_history}`. `project_fs.rs` has no `#[cfg(test)]` module at all. |
| `fts.rs` ↔ `project.rs` | **Real cycle in production code.** `fts.rs:2` `use crate::project;` (used at `:58,210,219,310,…`, all before the test module at `:633`); `project.rs:2715,4500` call `crate::fts::{search, update_paths}`, both before the test module at `:4641`. |
| `overleaf.rs` ↔ `overleaf_rt.rs` | **Not a runtime cycle.** `overleaf.rs → overleaf_rt.rs` is a clean layered dependency (6 references at `overleaf.rs:1672,1673,1695,1696,1710,2033`). Every reverse reference sits inside `overleaf_rt.rs`'s `#[cfg(test)] mod tests`, which starts at `overleaf_rt.rs:2267` — the lowest `crate::overleaf::` reference is at `:3010`. The cycle exists only in the `cargo test` graph. |

### 2.4 Overleaf, specifically

`overleaf_rt.rs` is a hand-written **Socket.IO 0.9** client, because Overleaf
ships `socket.io-client 0.9.17-overleaf-5` and the wire protocol is the legacy
`{type}:{id}:{endpoint}:{data}` framing, not Engine.IO v4. The module header
(`overleaf_rt.rs:1-40`) documents the handshake, upgrade, framing and the exact
frames Lattice emits, pinned against the Overleaf-Workshop VS Code extension.
Read that header before changing anything in the file.

`overleaf.rs` handles the non-realtime side: login/session
(`overleaf-session.json` in app data), clone, and a real three-way merge. The
merge keeps a pristine copy of every text file as of the last sync under
`.research/overleaf-base/` (`overleaf.rs:738`) — that is the common ancestor
without which only "both sides changed" could be detected, never how to
combine. Files with conflict markers are refused for upload
(`CONFLICT_MARKER`, `overleaf.rs:743`). Files above 45 MB are reported rather
than synced (`MAX_SYNC_FILE_BYTES`, `overleaf.rs:58`).

---

## 3. The collaboration model (Lattice Shares)

Implemented by `src/collab/collab-project-v2.ts` (1,150 lines) on the client,
`protocol/collab-v2.ts` (158 lines) as the shared contract, and
`collab-server/` (a Cloudflare Worker, 1,494 lines across 3 source files).

### 3.1 One Y.Doc per file

The wire identity of a room is a 3-tuple plus a protocol tag:

```ts
// protocol/collab-v2.ts:4
type TextFileRoomIdentityV2 = {
  protocol: 2; projectInstanceId: string; fileId: string; documentEpoch: number;
};
// protocol/collab-v2.ts:8 (inside textFileV2RoomName, declared at :6)
`v2~${base64UrlText(projectInstanceId)}~${base64UrlText(fileId)}~${documentEpoch}`
```

`projectInstanceId` and `fileId` must match `/^[A-Za-z0-9_-]{16,128}$/`
(`validRoomId`, `protocol/collab-v2.ts:155`); `documentEpoch` is a positive safe integer, and
the parser rejects non-canonical encodings (`protocol/collab-v2.ts:11`).

The **client-side** namespace type has a fourth field that is *not* part of the
room name: `TextNamespaceV2 = { deployment, projectInstanceId, fileId,
documentEpoch }` (`src/collab/collab-text-v2-store.ts:4`). `deployment` only scopes
local IndexedDB storage (`src/collab/collab-text-v2-store.ts:25`).

### 3.2 The client pool

`CollabTextProviderPoolV2` is created with capacity 8 by default
(`src/collab/collab-project-v2.ts:215`; it is an option, `poolCapacity?`, and the
constructor rejects < 1 at `src/collab/collab-text-v2.ts:108`).

Eviction (`src/collab/collab-text-v2.ts:117`) is `while (size > capacity)`, picking
the oldest `lastAccessed` client that is **unpinned**, **not a draft**, and
**clean**. Two details that matter and are easy to miss:

- "clean" means an empty outbox **and** `durableSeen` — a server durable-ack was
  observed (`src/collab/collab-text-v2.ts:69`).
- If no candidate qualifies, the loop returns. **The cap is soft**; the pool can
  legitimately exceed 8.

Eviction re-runs on `add`, `unpin`, `setDraft`, and on every client
durability-state change. It destroys clients without telling the controller;
the controller resurrects them defensively at `src/collab/collab-project-v2.ts:534`
and retries once at `:558`/`:569`.

### 3.3 Pin names: there are four, not three

```ts
// src/collab/collab-text-v2.ts:111-112
pin(client, reason: "main" | "secondary" | "chat" | "comments")
unpin(client, reason: "main" | "secondary" | "chat" | "comments")
```

There is no exported named type — the union is inline on the pool methods.
Call sites: `"chat"` at `src/collab/collab-project-v2.ts:282`, `"comments"` at
`:328`, and `"main" | "secondary"` via the `openPath` parameter at `:586-587`.
The controller's own `activePin` field is typed `"main" | "secondary"` only
(`src/collab/collab-project-v2.ts:141`).

`CLAUDE.md` lists only three pin names. It is missing `comments`.

### 3.4 `openPath`, `sideload`, and `activePath`

```ts
// src/collab/collab-project-v2.ts:524
async openPath(
  path: string,
  pin: "main" | "secondary" = "main",
  options: OpenPathOptionsV2 = {},   // { allowCachedOffline?, cachedFirst?, timeoutMs?, sideload?, activateIf? }
): Promise<Y.Text>
```

The activation gate is at `src/collab/collab-project-v2.ts:583`:

```ts
if (!options.sideload && (options.activateIf?.() ?? true)) {
```

**Nothing checks `pin === "main"`.** "Only the primary editor binding may
activate a doc" is a convention upheld by call sites, not an API invariant — a
non-sideload `openPath(path, "secondary")` would activate too.

The census below is `rg -n 'openPath\(' src/` minus tests; re-run it before
trusting it, and note that the same command also matches the unrelated
`materialized.openPath` *property* in `src/collab/collab-live.integration.test.ts`.

| Kind | Sites |
| --- | --- |
| **Non-sideload (activating)** — 2 | `src/App.tsx:2563` (the primary editor's file load, which additionally passes an `activateIf` guard) and `src/app/use-collab-v2-session.ts:601` (the host's share start) |
| Sideloaded, app code — 7 | six in `src/App.tsx` (secondary pane, saves, rename/move mirroring, external-change reload) and one in `src/app/use-collab-v2-session.ts:469`. Line numbers are omitted here on purpose: `App.tsx` is being actively refactored and they move constantly. |
| Sideloaded, internal to the controller — 4 | `src/collab/collab-project-v2.ts:275` (chat), `:324` (comments), `:483`, `:941` |

Both activating sites now live in different files: the `App.tsx` → `src/app/`
hook extraction moved the share-start path into
`src/app/use-collab-v2-session.ts`, so "both in `App.tsx`" is no longer true.
Every other caller — secondary pane, saves, observers, chat, comments — passes
`{ sideload: true }`.

Activation (`src/collab/collab-project-v2.ts:583-591`) pins the new client, unpins the
previous one, sets `activeClient`/`activePin`/`activePath`, repoints
`this.ytext` at `doc.getText("content")`, destroys and rebuilds the
`undoManager`, swaps `this.provider = { awareness }`, increments
`awarenessVersion`, announces presence and re-emits `canWrite`.

**Why a stray activation silently breaks the editor.** The primary editor's
yCollab extension set is a `useMemo` at `src/canvas/document-canvas.tsx:1651-1663`.
It returns `EMPTY_EXTENSIONS` when `collabSession.activePath !== activeFile`,
and `awarenessVersion` is one of its dependencies. A foreign activation both
moves `activePath` *and* bumps `awarenessVersion`, so the memo re-runs, sees a
mismatch, and drops the binding. No error is thrown; typing simply stops
syncing. Additionally, `setActivePath` throws unless the path already matches
(`src/collab/collab-project-v2.ts:787`).

Two further facts worth knowing:

- `activateIf` is a second guard, used so an aborted file switch cannot
  repoint `activePath` after the fact (see the `loadFile` callback in
  `src/App.tsx`).
- A sideloaded open **does not pin at all** — the `pin` argument is inert. That
  is exactly why chat and comments call `pool.pin(...)` explicitly afterwards.

### 3.5 Chat and comments ride catalog files

Project-wide chat and editor comments are not synthetic namespaces. They are
ordinary catalog files of `kind: "text"`, created on demand with an empty seed
and then opened sideloaded and pinned:

| Feature | Path | Constant | Y type |
| --- | --- | --- | --- |
| Project chat | `.research/collab-chat.json` | `src/collab/collab-session.ts:402` | `Y.Array` under key `"chat"` (`src/collab/collab-session.ts:393`) |
| Editor comments | `.research/editor-comments.json` | `src/editor/comments/editor-comment-data.ts:1` | `Y.Map` under `"comments"` + `"comments-meta"` (`src/collab/collab-comments.ts:27-28`) |

Creation and pinning: `src/collab/collab-project-v2.ts:272-282` (chat) and `:322-328`
(comments). The data lives on those Y types *beside* the `"content"` text,
which is normally empty — with one exception: comments run a one-time legacy
adoption that reads `doc.getText("content")` for pre-`Y.Map` documents
(`src/collab/collab-comments.ts:96-103`), and the on-disk mirror is serialized back to
JSON by `collabCommentsContent` (defined at `src/collab/collab-comments.ts:107`, called
from `src/collab/collab-project-v2.ts:1025`).

### 3.6 The server validates every fileId against the catalog

Synthetic namespaces genuinely do not work. There are four independent checks:

1. Ticket issuance requires a live, non-binary catalog file —
   `collab-server/src/project-coordinator-v2.ts:376`.
2. Ticket consumption re-checks existence, `live` state, epoch match, grant not
   revoked, project `live` — `project-coordinator-v2.ts:391-398`.
3. The Worker's `onBeforeConnect` parses the room name and requires the ticket
   claims to equal the room identity — `collab-server/src/index.ts:49-57`
   (400 `invalid_room`, 401 `ticket_required`, 403 `invalid_ticket`).
4. **Every mutating Yjs frame** is re-authorized: `authorizeTextMessage`
   (`project-coordinator-v2.ts:403`) is called from
   `collab-server/src/text-file-v2.ts:143`.

### 3.7 Read grants cannot write

```ts
// collab-server/src/text-file-v2.ts:135
if (state.permission === "read") return close(connection, 4403, "read_only_violation");
```

Scope matters: this fires only for Yjs sync frames (`kind.outer === 0 &&
kind.sync !== 0`, `text-file-v2.ts:134`). Read peers still send awareness and
SyncStep1 — so "cannot write", not "cannot send".

On the client, `closeEventErrorV2` (`src/collab/collab-text-v2.ts:96`) maps
`4401, 4403, 4410, 4411` and `1008` to a permanent error; `onDisconnect` then
sets `stopped`, disposes the transport, and never reconnects
(`src/collab/collab-text-v2.ts:84`); later `connect()` rejects immediately (`:47`).
Gate write paths in the UI — `canWrite` is exposed at
`src/collab/collab-project-v2.ts:186` and `onPermanentError` at `:638`.

Full server close-code table (`collab-server/src/text-file-v2.ts`):

| Code | Reasons |
| --- | --- |
| 4400 | `custom_messages_disabled`, `invalid_protocol`, `unsupported_message` |
| 1009 | `frame_too_large`, `awareness_too_large`, `update_too_large`, `document_too_large` |
| 4403 | `authority_revoked`, `read_only_violation` |
| 4429 | `frame_rate_limited`, `awareness_rate_limited`, `update_rate_limited` |
| 4410 | `file_deleted` |
| 4411 | `project_closed` |

`4401` and `1008` appear only in the client's mapping table; the server rejects
unauthenticated upgrades with HTTP 401 before a socket exists.

### 3.8 The server

Cloudflare Worker + two SQLite-backed Durable Objects + one R2 bucket
(`collab-server/wrangler.jsonc:2-19`, name `lattice-collab`).

- **`ProjectCoordinatorV2`** (`collab-server/src/project-coordinator-v2.ts:85`,
  939 lines) — one per project. Owns the file catalog and its revision/event
  log, project lifecycle (`importing | live | closing | closed`), the host
  secret and guest grants, one-time socket tickets (60 s TTL, 120/min), binary
  upload/download tickets with R2 references and a two-round GC
  (`runBinaryGc`, `:525`), a presence table with a 45 s TTL, alarm-backed retry
  of pending work (`alarm`, `:784`), and 30-day idle project expiry (`:593`).
- **`TextFileV2`** (`collab-server/src/text-file-v2.ts:56`, 388 lines) — extends
  `YServer` from `y-partyserver` with `hibernate: true`; one DO per
  `{project, file, epoch}` room. Owns the Y.Doc, chunked and hashed snapshot
  manifests with previous-generation fallback (`onLoad` `:66`, `onSave` `:163`),
  per-connection rate limits, per-frame authorization with a 60 s cache,
  `durable-ack` broadcast (`:183`), and fencing on delete/close/expiry.
- **Worker entry** (`collab-server/src/index.ts`, 167 lines) — routes
  `/v2/projects/:projectInstanceId/...` to the coordinator DO (`:35,:44`),
  except two byte-streaming sub-routes it handles itself: `binary/uploads|
  downloads/:ticket` (`:40`) and `text/imports/:fileId` (`:42`, PUT ≤ 5 MiB,
  hash-verified). WebSockets go through partyserver at
  `/parties/text-file-v2/<room>` (`:47`; party name at `protocol/collab-v2.ts:2`).

Auth is `Authorization: Bearer <secret>`, checked in `authenticateCredential`
(`project-coordinator-v2.ts:172`). `GrantPermission` is
`"read" | "write" | "host"` (`protocol/collab-v2.ts:22`), but a *grant* can only
ever be `read` or `write` (`project-coordinator-v2.ts:317`); `host` is
synthesised for the bootstrap-secret holder. Revocation bumps `authorityEpoch`
and pushes `revokeGrant` to every text DO with alarm-backed retries (`:321`).

Deploy with `pnpm collab:deploy`. `collab-server/` has its own `package.json`
and its own vitest config using the Cloudflare Workers pool — its tests
**cannot** run under the root runner and are excluded in `vitest.config.ts`.

### 3.9 The `v2` suffix is vestigial

There is no surviving v1 code path.

- No v1 client module exists; `git log -- src/collab-project.ts` is empty.
- The only trace of a v1 server class is the wrangler migration ledger, where
  `LatticeDoc` is created in tag `v1` and deleted in tag `v4`
  (`collab-server/wrangler.jsonc:20-37`). Cloudflare requires the ledger to
  stay; no source references it.
- The code says so: `src/collab/collab-control-v2.ts:4` — "v2 is the only room type
  now"; `src/collab/collab-feature-policy.ts:11` — "v1 rooms are retired".
- `mayResumeCollabProject(version: 1 | 2, …)` ignores its argument
  (`void version;`, `src/collab/collab-feature-policy.ts:52`).
- Everything else hard-requires 2: `CONTROL_PROTOCOL_VERSION = 2`
  (`protocol/collab-v2.ts:1`), `src/collab/collab-rooms.ts:9,30`,
  `src/collab/collab-invitation-v2.ts:43`, and `useState<2 | null>` for the active
  version in `src/App.tsx`.

Renaming is mechanical but broad: 28 tracked files carry `v2` in their *name*,
and 62 files under `src/`, `protocol/` and `collab-server/` reference a `v2`
identifier at all (`rg -l 'V2|collab-v2|"v2|/v2/' src protocol collab-server`,
excluding the vendored trees) — plus the wire-protocol prefix. So it has not
been done.

---

## 4. On-disk data model

A Lattice project is an ordinary folder. Everything Lattice adds lives under
`.research/`. `prepare_project_skeleton` (`src-tauri/src/project.rs:326`)
creates it.

| Path | Owner | Contents |
| --- | --- | --- |
| `.research/project.json` | `project.rs:23` (`MANIFEST_PATH`) | project manifest: name, venue, root documents, spelling words |
| `.research/brief.md` | `project.rs:358` | the project brief shown in the sidebar |
| `.research/papers/<arxivId>/` | `papers.rs` | imported papers: `paper.md`, `blog.md`, `metadata.json`, `paper_assets/` |
| `.research/history/<id>.json` | `project.rs:5445` | transaction history records (schema v2, `project.rs:35`); capped at 100 (`MAX_HISTORY_ENTRIES`) |
| `.research/sessions/` | `project.rs:332` | agent session records |
| `.research/checkpoints/` | agent runtime | turn checkpoints; capped at 100 per session / 256 MB (`project.rs:32-33`) |
| `.research/cache/` | various | `fts.sqlite` (full-text index), `citation-health-v1.json`, `materialization-index-v1.json` |
| `.research/licenses/` | `project.rs:333` | license texts for imported material |
| `.research/overleaf.json` | `overleaf.rs:47` | Overleaf link state: project id, file hashes, sync mode |
| `.research/overleaf-base/` | `overleaf.rs:738` | pristine copies of every synced text file — the merge base for three-way sync |
| `.research/editor-comments.json` | `project.rs:25` | editor comment threads (also a collab catalog file) |
| `.research/collab-chat.json` | `src/collab/collab-session.ts:402` | project-wide chat (collab catalog file) |
| `.research/pdf-annotations.json` | `project.rs:24` | PDF annotations |
| `.research/tutorial.json` | `project.rs:372` | tutorial-project state |
| `.research/omp-*` | agent runtime | agent runtime scratch; excluded from export and from agent reads |

The Overleaf session cookie is **not** in the project — it lives in app data
(`overleaf-session.json`, `overleaf.rs:45`).

Two gitignore files are written at project creation (`project.rs:335-347`):
`.research/.gitignore` contains `history/ sessions/ checkpoints/ cache/`
(`RESEARCH_GITIGNORE`, `project.rs:30`), and the project's root `.gitignore`
gets the same four paths plus `/main.pdf` and the LaTeX build-artifact list.
`ensure_ignore_line` re-applies these when Lattice adopts a folder it did not
create (`project.rs:549-557`) — otherwise the first commit would adopt every
`.log` and `.fls` in the directory.

Export (`export_project_zip`) excludes `.git/`, `.research/history`,
`sessions`, `omp-*`, `checkpoints`, `cache`, and the usual TeX artifacts
(`project.rs:967-990`). Agent file access is gated by an allowlist that permits
`.research/papers/**` and normal project files but blocks history, sessions and
`omp-*` (`project.rs:3857-3866`).

---

## 5. Performance and bundle constraints

These are deliberate. Breaking one regresses cold start for every user, and the
regression is not visible in a dev build.

### 5.1 The eager-startup JavaScript budget

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
harper, the CodeMirror language packs, TipTap, Univer, tldraw.

`src/canvas/canvas-lazy-modules.ts` is the canonical example of how to do this, and
its header explains a subtlety worth repeating: **each loader is the identity of
a chunk**. Import the loader; do not inline `import("./pdf-viewer")` at a call
site, or that site gets its own copy of the module graph in a second chunk.

### 5.2 Never value-import `tldraw` from an eagerly-loaded module

`tldraw`'s barrel has no `sideEffects` flag, so a single value import drags
~1.5 MB plus prosemirror into the startup chunk. The whiteboard lives behind
`loadBoardEditorModule()` (`src/canvas/canvas-lazy-modules.ts:31`), and the
agent-facing adapter is isolated in `src/agent/agent-canvas-tldraw-adapter.ts` so that
`src/agent/agent-canvas-tools.ts` can register it without importing tldraw itself.

Non-test value importers of `tldraw` today: `src/editor/board/board-editor.tsx`,
`src/editor/board/board-yjs-bridge.ts`, `src/agent/agent-canvas-tldraw-adapter.ts` — all reachable
only through the lazy board chunk.

**This rule is not lint-enforced.** There is no `no-restricted-imports` entry
for it in `eslint.config.js`. The only backstop is the eager-JS budget, which
fails the build after the fact. Treat it as a convention you must uphold by
hand.

### 5.3 The shiki grammar allowlist

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

### 5.4 `panic = "abort"` is deliberately off

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

This pairs with the panic hook installed by `std::panic::set_hook` at
`lib.rs:3732`, which logs to `lattice::panic` — and only works because panics
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

## 6. The design-system contract

Palette and spacing decisions are enforced by tests, not by review.

Layout: `src/App.css` is a 10-line import manifest for `src/styles/`:
`foundations.css` (496 lines — the token scale), `surfaces.css`, `theme.css`
(142 — the palette), `app-shell.css`, `editor-workspace.css` (2,036),
`workspace-panels.css`, `dialogs.css`, `adaptive-feedback.css`.
`src/index.css` layers Tailwind v4 **without** preflight and maps shadcn's
colour names onto the app's own theme variables.

`src/styles/tokens.test.ts` (351 lines, 18 cases) fails the build when:

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

`src/styles/surfaces.test.ts` (307 lines) covers the surface layer.

Run them without the full gate:

```console
pnpm vitest run src/styles/tokens.test.ts
pnpm vitest run src/styles/surfaces.test.ts
```

The reasoning behind the density and typography choices is in
[`design-system.md`](design-system.md).

---

## 7. The gate

```console
pnpm check     # = mise run check
```

`mise.toml`'s `check` task depends on eight stages that run in parallel, each
skipped when its declared `sources` have not changed (`mise.toml:145`):
`i18n-check`, `lint`, `test`, `build`, `collab-server`, `cargo-fmt`,
`cargo-test`, `clippy`. It needs [mise](https://mise.jdx.dev).

CI (`.github/workflows/ci.yml`) covers the same ground across four jobs:
`test`, `collab-server` (`typecheck` + `test` in that sub-project),
`lint-and-build` (`pnpm lint`, `pnpm build`, `pnpm i18n:check`) and `rust`
(`cargo fmt --check`, `cargo test`, `cargo clippy -D warnings`).

`pnpm lint` runs `eslint src --max-warnings 128`. That cap is a debt ratchet:
lower it when you remove warnings, never raise it.

Testing environment: Vitest + jsdom + fake-indexeddb, 20 s test timeout
(`vitest.config.ts:34`), `collab-server/**` and `.tmp/**` excluded
(`vitest.config.ts:29`). Collab tests stub `fetch` against a mock coordinator;
the worked example is `setupCreateTest` at
`src/collab/collab-project-v2.test.ts:969`. Note that it is **not importable** — it is
a plain `async function` declared inside the `describe("v2 mid-share file
creation")` block, and the file exports nothing at all. Copy the harness into
your own suite rather than reaching for an import that does not exist.
`App.test.tsx` renders
the real `App` with a mocked `invoke`, and startup ordering matters: the
backend's `initial_project` (`lib.rs:744`; see `initialProjectProbe` in
`src/App.tsx`) must beat the recent-project auto-reopen.

CI runners are slow. Avoid tests that assume nothing re-renders between two
events; async highlight and render passes can land in between.
