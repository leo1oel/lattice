<div align="center">

<img src="./src-tauri/icons/app-icon.svg" alt="Lattice app icon" width="112" />

# Lattice

**A local-first LaTeX workspace for writing research with agents.**

Edit, compile, review, cite, and collaborate on a real project folder — without
moving your manuscript into a proprietary document format.

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?label=release&color=4568f6)](https://github.com/leo1oel/lattice/releases/latest)
[![CI](https://github.com/leo1oel/lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/leo1oel/lattice/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/macOS-Apple%20Silicon-202124?logo=apple&logoColor=white)](https://github.com/leo1oel/lattice/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-25b4bb)](LICENSE)

[**Download for macOS**](https://github.com/leo1oel/lattice/releases/latest) ·
[Install and use](#install-and-use) ·
[Develop locally](#develop-locally) ·
[Report an issue](https://github.com/leo1oel/lattice/issues)

</div>

---

Lattice keeps the project folder authoritative. Your manuscript remains normal
LaTeX on disk, builds with your local `latexmk`, and stays usable with any other
editor. The native app adds a focused writing surface, continuous PDF review,
research context, an embedded agent workspace, and optional collaboration.

Official builds target **Apple Silicon Macs running macOS 11 or later**. Release
artifacts are signed and notarized, and support in-app updates.

## Why Lattice

| Principle | What it means in practice |
| --- | --- |
| **Local first** | Files on disk are the source of truth. Lattice metadata is human-readable and lives beside the project. |
| **Agent native** | The agent sees the active manuscript, selection, papers, and build context, while changes remain reviewable and reversible. |
| **LaTeX all the way down** | Compilation uses the local TeX toolchain; there is no export step and no proprietary manuscript format. |
| **Collaboration is optional** | Work alone, sync with Overleaf, or share through per-file Yjs documents while every peer keeps a local project. |

## Capabilities

| | |
| --- | --- |
| ✍️ **Source editing** | CodeMirror 6, parser-aware LaTeX highlighting, TexLab diagnostics and completion, Vim/Emacs keymaps, symbol previews, and LaTeX-aware formatting |
| 📄 **PDF review** | Continuous PDF.js preview, draggable split view, SyncTeX source navigation, search, zoom, annotations, and export |
| 🤖 **Writing agent** | A bundled Synara workspace for compatible local providers, with live manuscript context, permission modes, reviewable edits, and checkpoint-backed recovery |
| 📚 **Evidence and citations** | arXiv paper snapshots, bibliography tools, citation autocomplete, reference previews, and related-work discovery through OpenAlex |
| 👥 **Collaboration** | Overleaf sync and realtime editing, or Lattice Shares with per-file CRDT sync, named cursors, shared assets, comments, and project chat |
| 📝 **Notes and boards** | Visual Markdown, Mermaid diagrams, and tldraw whiteboards that remain part of the project workspace |
| 🕘 **History and quality** | File-level change history, reversible local transactions, agent checkpoints, Harper grammar checks, `texcount`, SQLite full-text search, and a TeX doctor |

## Install and use

1. **[Download the latest release](https://github.com/leo1oel/lattice/releases/latest)** and drag Lattice into Applications.
2. Install a TeX distribution that provides `latexmk`. Lattice checks the local toolchain on first launch and guides you through missing pieces.
3. Choose **New project** for a bundled NeurIPS, ICML, or ICLR 2026 skeleton, or **Open folder** for an existing project.
4. Press `Cmd+S` to save and build. Import an arXiv URL to add evidence, or select a passage before messaging the agent to give it precise context.

The Agent settings surface manages compatible providers, models, skills, and
MCP servers. Provider availability depends on the tools configured on your Mac.

## Local-first project format

Lattice keeps ordinary source and asset files untouched. App-specific metadata,
imported research, local history, and agent sessions live under `.research/`.
A typical project contains entries like these:

```text
paper-project/
├── main.tex
├── references.bib
├── figures/
└── .research/
    ├── project.json                     # project metadata and root documents
    ├── brief.md                         # research brief available to the agent
    ├── papers/<paper-id>/paper.md       # imported evidence snapshots
    ├── history/<transaction-id>.json    # reversible local edits
    └── sessions/<conversation-id>.json  # agent conversation state
```

The LaTeX project can still compile without `.research/`, but deleting that
directory removes Lattice-specific data such as imported papers, history, and
agent sessions. New projects git-ignore private history, sessions, checkpoints,
and caches by default.

## Data, safety, and connected services

“Local first” describes ownership of the project; it does not mean every
optional feature is offline.

- Project paths crossing the UI/backend boundary are validated against the
  active project root.
- The agent runs with local permissions inside the project. Permission modes and
  reversible history make its changes explicit; they are not a security sandbox.
- Untrusted projects compile with shell escape disabled.
- Bibliography mutations are routed through Lattice's citation tools rather
  than unrestricted direct writes.
- Lattice Shares credentials use the macOS Keychain rather than project files
  or browser storage; other integrations keep their own documented credential
  boundaries.
- Imported paper Markdown is sanitized before rendering.
- Agent providers, Overleaf, OpenAlex, arXiv imports, and Lattice Shares connect
  to their corresponding remote services when you use them.

## Architecture

The React 19 + TypeScript interface runs inside Tauri 2. Rust owns filesystem
validation, project transactions, LaTeX builds, paper and bibliography changes,
Overleaf integration, and supervision of the bundled agent sidecar.

```text
┌──────────────────────── React / TypeScript ────────────────────────┐
│ Editor · PDF review · papers · history · collaboration · agent UI │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ typed Tauri commands and events
┌──────────────────────────────▼─────────────────────────────────────┐
│ Rust / Tauri                                                     │
│ path validation · transactions · latexmk · Git · Overleaf · FTS  │
└───────────────┬──────────────────────────────┬─────────────────────┘
                │                              │
                ▼                              ▼
       project folder on disk        bundled Synara sidecar

Optional collaboration path:
editor ⇄ per-file Y.Doc ⇄ Cloudflare Durable Object ⇄ peer Y.Doc ⇄ disk
```

Lattice Shares gives every file its own Yjs document namespace and uses a small
Cloudflare Worker in `collab-server/` for transport and durability. Each peer
materializes files locally and compiles with its own toolchain. The agent
workspace runs a pinned [Synara](https://github.com/leo1oel/synara) revision;
the ownership and security boundary is documented in
[`docs/synara-runtime.md`](docs/synara-runtime.md).

**Stack:** Tauri 2 · React 19 · TypeScript · Vite 7 · Tailwind CSS 4 ·
CodeMirror 6 · TipTap 3 · PDF.js · Yjs / y-partyserver · tldraw · KaTeX ·
Harper · SQLite FTS5

## Develop locally

### Prerequisites

- Node.js 22.13 or later and pnpm 10
- Stable Rust with `rustfmt` and `clippy`
- The [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- A TeX distribution with `latexmk` for compile flows
- Git and a sibling checkout of the pinned Synara source
- A `VITE_TLDRAW_LICENSE_KEY` in `.env.local` for licensed board builds (see `.env.example`)

The web build and most tests run on Linux or macOS; official desktop release
artifacts are currently produced only for Apple Silicon macOS.

### Setup

```bash
# From the Lattice repository root, create the sibling checkout expected by
# scripts/synara-runtime.json and pin it to the recorded revision.
git clone https://github.com/leo1oel/synara.git ../synara-poc
git -C ../synara-poc checkout "$(node -p \
  "JSON.parse(require('node:fs').readFileSync('scripts/synara-runtime.json', 'utf8')).revision")"

corepack enable
corepack prepare pnpm@10 --activate
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` stages the development sidecar automatically before starting
the desktop app. `pnpm dev` starts only the Vite frontend and is not a complete
desktop development environment.

### Common commands

| Command | Purpose |
| --- | --- |
| `pnpm tauri dev` | Stage Synara and run the desktop app |
| `pnpm vitest run <file>` | Run one focused frontend test file |
| `pnpm test` | Run the full Vitest suite |
| `pnpm build` | Type-check and build the web frontend |
| `pnpm check` | Run lint, Vitest, web build, Cargo tests, and Clippy with warnings denied |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all` | Format Rust; CI checks this separately from `pnpm check` |
| `pnpm collab:dev` | Run the collaboration Worker locally |

Before opening a pull request, run both:

```bash
pnpm check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

### Repository layout

| Path | Responsibility |
| --- | --- |
| `src/` | React application, editors, collaboration clients, and frontend tests |
| `src-tauri/src/` | Rust commands, project safety, builds, Git, papers, Overleaf, and sidecar supervision |
| `protocol/` | Types and invariants shared by the app and collaboration server |
| `collab-server/` | Cloudflare Worker and Durable Objects for Lattice Shares |
| `scripts/` | Sidecar staging, vendoring, verification, and release tooling |
| `docs/` | Design decisions, subsystem contracts, and performance notes |
| `src/open-knowledge-app/` | Vendored editor code; re-vendoring can overwrite local changes |

Keep heavy editor dependencies behind existing lazy boundaries: importing
PDF.js, TipTap, tldraw, Mermaid, KaTeX, or CodeMirror language packs near the
eager app shell can materially increase startup cost.

## Self-host collaboration

Lattice Shares runs on a Cloudflare Worker in your own account:

```bash
pnpm collab:login
pnpm collab:deploy
```

Use the resulting `*.workers.dev` host in **Live collaboration → Advanced**, or
set `VITE_LATTICE_COLLAB_HOST` when building the app. See
[`collab-server/README.md`](collab-server/README.md) for local testing and
deployment details.

## Design and subsystem docs

- [`docs/design-system.md`](docs/design-system.md) — visual tokens, density, and component contracts
- [`docs/project-history-architecture.md`](docs/project-history-architecture.md) — local transactions and agent checkpoints
- [`docs/synara-runtime.md`](docs/synara-runtime.md) — bundled agent runtime and host boundary
- [`docs/overleaf-integration-baseline.md`](docs/overleaf-integration-baseline.md) — protocol assumptions and regression baseline
- [`docs/performance.md`](docs/performance.md) — startup and editor performance constraints

## Maintainer release flow

The version helper edits `package.json`, `tauri.conf.json`, `Cargo.toml`, and
`Cargo.lock` together, then prints the commit and tag commands:

```bash
node scripts/bump-version.mjs patch
```

Pushing the resulting `vX.Y.Z` tag triggers CI to build, sign, notarize, and
publish the release and update the in-app updater feed. Maintainers should read
[`AUTO-UPDATE-SETUP.md`](AUTO-UPDATE-SETUP.md) before running a release.

## License

Lattice is licensed under the [Apache License 2.0](LICENSE). Bundled and adapted
components retain their own licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for details, including the
separate tldraw SDK license requirement.
