# Plugins

Plugins add commands to Lattice. Each plugin is a separate process that
Lattice starts when the writer runs one of its commands. Lattice and the
plugin talk over a small, versioned JSON-RPC protocol. The plugin returns a
typed result (a message, a list of items, or diagnostics) and Lattice renders
it natively in both the Tauri and the GPUI app. A plugin never draws UI and
never writes a file: a change such as a new `.bib` entry comes back as an
action the writer confirms in Lattice's own UI.

This page is the contract for plugin authors and for anyone changing the host.
The host is `src-tauri/lattice-core/src/plugins/` (shared by both apps); the
machine-readable API is [`plugin-api/schema/level-1.json`](../plugin-api/schema/level-1.json).

## What a plugin can access

On macOS, a plugin can access only what its manifest declares and the writer
granted. Lattice enforces this; it is not a promise the plugin makes.

| Access | Without a grant | With a grant |
|---|---|---|
| Files | Its own folder (read), its data folder `<app data>/plugins/data/<id>/` (read and write), system libraries | Nothing more: there is no file permission in API level 1 |
| Project | The project's name | `project-read = ["context"]`: main document, active file, bibliography paths, selection (≤ 12,000 characters), cursor. `project-read = ["bibliography"]`: parsed `.bib` entries through `bibliography/entries` |
| Network | None | `network-local = [23119]`: direct connections to those loopback ports only. `network = ["https://api.example.org"]`: requests to those origins through `http/fetch`, which Lattice performs |
| Secrets | None | `secrets = ["api-key"]`: values the writer saves in Settings, stored in the Keychain, read through `secrets/get` |
| Environment | `PATH=/usr/bin:/bin`, `HOME` and `TMPDIR` in the data folder, `LANG`, `LATTICE_PLUGIN_ID`, `LATTICE_PLUGIN_API_LEVEL`, `LATTICE_PLUGIN_DATA_DIR` | The same: the writer's environment (and any API key in it) never reaches a plugin |
| Processes | Its entry point only (`exec` plugins: any executable in their own folder) | — |

How it is enforced:

- **Sandbox.** Every run is wrapped in a Seatbelt profile generated from the
  grant (`plugins/sandbox.rs`): `(deny default)`, then only the reads,
  writes, executables and loopback ports above. Seatbelt cannot name remote
  hosts, which is why remote access goes through `http/fetch`; a redirect is
  followed only to another declared origin.
- **Broker.** Every host call checks the grant and fails with
  `permissionDenied` (code -32001, `data.permission` names what was missing).
- **Results.** Lattice parses results leniently and checks every action
  before showing it: paths must stay inside the project, URLs must be
  http(s), BibTeX must be exactly one valid entry. Anything else is dropped.
- **No project-driven plugins.** Nothing in a project folder can install,
  enable or configure a plugin. Projects come from collaborators, Overleaf and
  arXiv; Obsidian's PHANTOMPULSE attack came through a vault's own config.
- **Grants are explicit.** A plugin is installed off. Enabling it shows its
  permissions and grants exactly those. An update that asks for more is turned
  off (URL installs) or stops running (folder installs) until the writer
  reviews and enables it again.
- **One process per command.** A plugin runs only while a command the writer
  chose is running, at most 120 seconds, and its whole process group is
  stopped afterwards.

Boundaries (what this does **not** cover):

- Plugins run only on **macOS**. On Linux and Windows they are listed but do
  not run, the same as the built-in agent without its bibliography guard
  (decision D1). There is no "trusted, unsandboxed" mode.
- Metadata of the folders above a plugin's own folders (names along the path,
  not their contents) is readable, because path resolution needs it.
- `sandbox-exec` is deprecated by Apple but still used by Lattice's agent,
  Codex and Chromium. If a macOS release breaks it, plugins stop running
  rather than run unsandboxed.
- A plugin can be wrong. Lattice confirms every write it proposes, but it
  cannot tell you whether a search result or a diagnostic is correct.
- A plugin can use what it was granted for anything: a plugin with
  `network-local = [23119]` can read your whole Zotero library through the
  local API. Grant what you would give the author.

## Installing

Settings › Plugins:

- **Install from URL**: the URL of a `.zip` release (https) and its SHA-256,
  which the author publishes beside it. Lattice downloads it, checks the hash
  before unpacking anything, and keeps it unchanged in
  `<app data>/plugins/packages/<id>/<version>/`. The plugin's licence must be
  on Lattice's list (below).
- **Install from folder**: for developing a plugin. Lattice runs it in place,
  so edits apply on the next run, and any licence is accepted.

Then turn the plugin on, which shows what it asks for. Its commands appear in
the command palette (⌘K) as "<Plugin>: <Command>".

Settings › Plugins › Browse installs reviewed plugins from the registry
(`lattice-writer/lattice-plugins`: a signed index of versions and hashes and a
remote block list). [Publishing a plugin](guide/plugin-publishing.md) in the
user guide walks an author through listing one.

## Writing a plugin

A plugin is a folder with `lattice-plugin.toml` and its code.

### Start from the SDK

[`plugin-sdk/`](../plugin-sdk/README.md) (MIT) has the runtime (`definePlugin`,
one file, no dependencies), TypeScript types generated from the schema, a pack
script that prints the SHA-256 for a URL install, and two reference plugins to
copy: [`examples/plugins/zotero-search`](../examples/plugins/zotero-search) and
[`examples/plugins/bib-check`](../examples/plugins/bib-check). The examples are
real plugins: lattice-core's tests run `bib-check` inside the sandbox.

### Manifest

```toml
schema = 1                           # manifest format
id = "dev.example.zotero-search"     # reverse-domain, lowercase, unique
name = "Zotero search"
version = "0.1.0"                    # the plugin's own version
api = 1                              # the lowest plugin API level it needs
license = "MIT"                      # SPDX
description = "Search your Zotero library and cite from it."
repository = "https://github.com/example/zotero-search"
runtime = "node"                     # or "exec"
main = "main.js"                     # node: the entry script

# exec: one executable per Rust target triple
# [targets]
# aarch64-apple-darwin = "bin/plugin"

[permissions]
project-read = ["bibliography"]      # "context", "bibliography"
network-local = [23119]              # loopback ports
network = []                         # https origins, through http/fetch
secrets = []                         # names; values entered in Settings

[[commands]]
id = "search"
title = "Search Zotero…"
description = "Find an item and cite it."
input = { kind = "text", placeholder = "Title, author or citation key" }
```

Unknown top-level keys are ignored, so a manifest written for a newer Lattice
still loads. An unknown key under `[permissions]` is an error: it asks for
something this Lattice cannot enforce.

### Runtimes

- `node`: Lattice runs `main` with the Node it ships (Node 24). Lattice
  keeps a Node of at least this major version for plugins even if the agent
  stops needing it (decision D3).
- `exec`: a native executable for the target triple Lattice runs on
  (`aarch64-apple-darwin`, `x86_64-apple-darwin`). Interpreted plugins
  (Python, a shell script) cannot rely on a system interpreter: the sandbox
  starts only executables inside the plugin's folder.

WebAssembly is not a runtime yet; the protocol does not depend on the
transport, so adding one later changes no API.

### Protocol

JSON-RPC 2.0 over stdin and stdout, **one JSON message per line** (UTF-8,
at most 8 MiB). Anything else on stdout ends the run; write logs to stderr or
send the `log` notification.

One run:

1. Lattice → `initialize` with `{ hostApiLevel, hostApiCompat, hostVersion,
   plugin: { id, version }, granted, locale, platform }`. Answer
   `{ apiLevel }`, a level between `hostApiCompat` and `hostApiLevel`
   that the plugin speaks. Lattice may stop a plugin that does not answer
   within 10 seconds.
2. Lattice → `command/run` with `{ command, input?, context }`.
3. While working, the plugin may call the host (below) and send
   notifications.
4. The plugin answers `command/run` with a result. Lattice then closes
   stdin and ends the process group. A run that passes 120 seconds or that
   the writer cancels gets `$/cancelRequest { id }` first.

`context`: `{ project: { name, mainDocument?, activeFile?, bibliographies },
selection?: { text, file, from, to }, cursor?: { file, position } }`. Paths
are project-relative with `/`; positions are 1-based `{ line, column }`.
Without `project-read = ["context"]` only `project.name` is filled.

Plugin → Lattice:

| Method | Needs | Params → result |
|---|---|---|
| `bibliography/entries` | `project-read: bibliography` | `{ file? }` → `{ files: [{ path, entries: [{ key, type, fields, line }], error? }] }`. Field names lower-cased, `@string` macros expanded |
| `http/fetch` | the URL's origin in `network` | `{ url, method?, headers?, body? }` → `{ status, headers, body }`, bodies ≤ 4 MiB, 30 s |
| `secrets/get` | the name in `secrets` | `{ name }` → `{ value? }` |
| `log` (notification) | — | `{ level, message }`, `level` one of `error`, `warn`, `info`, `debug` |
| `progress` (notification) | — | `{ message, fraction? }`, shown while the command runs |

Errors use JSON-RPC's codes plus `permissionDenied` (-32001),
`unsupportedApiLevel` (-32002), `hostError` (-32003) and
`requestCancelled` (-32800). Answer `command/run` with an error
`{ code, message }` to show the writer `message`.

### Results

Every result may carry `summary`, plain text that stands for the whole result
in logs and notifications, and later as an agent's tool output.

- `{ kind: "message", markdown }`: CommonMark, no raw HTML.
- `{ kind: "items", items: [{ id, title, subtitle?, detail?, badges?, actions? }] }`:
  a list the writer picks from; the first action runs on Return.
- `{ kind: "diagnostics", items: [{ id, file, line?, severity, code?, message, fixes? }] }`:
  problems in project files. `severity` is `error`, `warning` or `info`;
  `code` is a stable rule name (`duplicate-key`).

Actions are verbs Lattice performs; the plugin only supplies arguments and an
optional `title`:

| `type` | Arguments | What Lattice does |
|---|---|---|
| `insertCitation` | `key` | Inserts `\cite{key}` at the cursor of the active source file |
| `addBibEntry` | `bibtex`, `file?` | Shows the entry and adds it to the bibliography after the writer confirms |
| `replaceBibEntry` | `key`, `bibtex`, `file?` | Shows the change and replaces entry `key` after the writer confirms |
| `reveal` | `file`, `line?` | Opens the project file at the line |
| `openUrl` | `url` (http or https) | Opens it in the browser |
| `copy` | `text` | Copies it |

Results are designed to be read by programs as well as people (decision D9):
stable ids and rule codes, typed actions with plain arguments, and plain-text
summaries. Exposing plugin commands to the agent is a later, separate change.

## Compatibility

Three versions are kept apart: the manifest `schema`, the host's plugin API
**level**, and the plugin's own `version`. A plugin declares the lowest level
it needs (`api`); there is no maximum, so a plugin keeps working on every
later Lattice until its level is retired.

The API contract (adapted from Neovim's `api-contract`, `runtime/doc/api.txt`,
Apache-2.0):

- Levels only add: new methods, new optional fields, new result kinds, new
  action types, new enum values. Each addition raises the level and carries the
  level it arrived in (`since`).
- A published method's name, direction and parameters never change, and a
  field never changes type or becomes required.
- A result object may gain fields; read only what you know.
- Anything not in the schema or this page is private and may change.
- Lattice shows a result kind it does not know as its `summary`, so a plugin
  built for a newer level still works on an older Lattice. An action type it
  does not know is dropped.
- Retiring a level raises `hostApiCompat`. It is announced in the deprecation
  register below with the earliest release that may drop it, at least two
  minor releases ahead (after MCP's deprecated-features register).

Unstable APIs, when there are any, live under `unstable/*` and require
`unstable = [...]` in the manifest; plugins using them are not accepted in
the registry.

The schema is generated from the Rust types (`plugins::schema`) and committed
per level. `cargo test -p lattice-core plugins::schema` fails when the file
is out of date (`LATTICE_UPDATE_PLUGIN_SCHEMA=1` regenerates it), and
`node scripts/check-plugin-api-schema.mjs [--base <ref>]` (in CI) fails when
the file removes or narrows anything the base revision or a lower level had.

### Deprecation register

| Item | Deprecated in | Earliest removal | Replacement |
|---|---|---|---|
| — | — | — | — |

## Licences

Lattice accepts these SPDX licences for plugins installed from a URL (after
Zed's extension list): 0BSD, Apache-2.0, BSD-2-Clause, BSD-3-Clause,
BSL-1.0, GPL-3.0(-only/-or-later), ISC, LGPL-3.0(-only/-or-later), MIT,
MPL-2.0, Unlicense, Zlib. The plugin SDK and the reference plugins are MIT
(decision D5).

## Decisions

Leo approved §9 of the design (2026-11-17) as recommended:

- **D1** No sandbox, no plugins: Linux and Windows fail closed.
- **D2** On macOS, Lattice promises "only what it declares", with the
  boundaries above written down.
- **D3** Two runtimes: the bundled Node and per-target executables.
- **D4** v1 installs from a URL with a SHA-256; the registry, block list and
  signing (key held by Leo) come later.
- **D5** SDK and templates MIT; a Zed-style licence list.
- **D6** TOML manifest.
- **D7** API level 1 grants `context` and `bibliography`; reading arbitrary
  project files will be a separate permission (`project-read = ["files"]`
  is refused until then).
- **D8** Lattice builds the host; the reference plugins and SDK are
  templates contributors can take over.
- **D9** Results are machine-readable now.
