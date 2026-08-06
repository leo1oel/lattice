<div align="center">

# Lattice

**A local-first, agent-first LaTeX writing environment for scientific papers.**

Write, compile, review, collaborate, and revise a real LaTeX project on disk —
with an embedded AI writing agent, imported arXiv evidence, and live collaboration
in one native macOS app.

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?label=release&color=2b2b2e)](https://github.com/leo1oel/lattice/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon)-2b2b2e)](https://github.com/leo1oel/lattice/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-2b2b2e)](LICENSE)

[**Download for macOS**](https://github.com/leo1oel/lattice/releases/latest) ·
[Report an issue](https://github.com/leo1oel/lattice/issues)

</div>

---

Lattice keeps your project folder authoritative: the manuscript stays a normal
LaTeX project on disk, builds with your local `latexmk`, and nothing locks you
in. Installed builds are signed, notarized, and ship in-app auto-updates.

## Highlights

| | |
|---|---|
| ✍️ **LaTeX editing** | CodeMirror 6 with parser-aware LaTeX highlighting, TexLab diagnostics and completion, optional Vim/Emacs keymaps, `\cite`/`\ref` hovers with previews, and LaTeX-aware formatting |
| 📄 **PDF review** | Continuous PDF.js preview beside the source with a draggable split, SyncTeX click-to-source, search, zoom, and export |
| 🤖 **Writing agent** | A local Claude Code / Codex session embedded in the sidebar (bundled Synara runtime) that makes evidence-aware edits, streamed into a reviewable conversation with reversible transactions |
| 📚 **Papers & citations** | Import arXiv papers as Markdown snapshots with one paste, manage the bibliography through `bibcite`, autocomplete citation keys, and discover related work via OpenAlex |
| 🔗 **Overleaf sync** | Two-way sync with an Overleaf project — live edits, tracked changes, comments, and chat — so co-authors who stay in the browser stay in the loop |
| 👥 **Lattice Shares** | CRDT-based real-time collaboration with named cursors, per-file sync, shared figures and papers, inline comments, and a project-wide chat |
| 📝 **Markdown & boards** | A visual Markdown editor for notes and paper snapshots, Mermaid diagrams, and tldraw whiteboards the agent can draw on |
| 🕘 **History** | Every direct edit, import, and agent change is one reversible transaction; a git timeline shows diffs per file and lets you restore |
| 🧰 **Quality tools** | Harper grammar checking, `texcount` word counts, full-text project search (SQLite FTS), compile diagnostics, and a TeX toolchain doctor |

## Getting started

1. **[Download the latest release](https://github.com/leo1oel/lattice/releases/latest)** and drag Lattice into Applications. Requires an Apple Silicon Mac (macOS 11+).
2. Install a TeX distribution if you don't have one — Lattice checks your toolchain on first launch and walks you through setup.
3. Choose **New project** for a venue-ready skeleton (NeurIPS, ICML, and ICLR 2026 styles are bundled) or **Open folder** for an existing LaTeX directory.
4. `Cmd+S` saves and builds. Paste an arXiv URL into the paper importer to add evidence. Select text before messaging the agent to focus it on a passage.

The agent panel uses the compatible tools on your machine (Claude Code, Codex,
and other CLI-backed providers) — configure providers, models, skills, and MCP
servers from the embedded settings.

## The project format

Lattice adds one human-readable sidecar next to normal LaTeX files. The
manuscript still builds if `.research/` is deleted.

```text
paper-project/
├── main.tex
├── neurips.sty
├── references.bib
├── figures/
└── .research/
    ├── project.json                     # app metadata
    ├── brief.md                         # research brief the agent reads
    ├── papers/<arxiv-id>/paper.md       # imported evidence snapshots
    ├── history/<transaction-id>.json    # reversible local history
    └── sessions/<conversation-id>.json  # agent conversations
```

History and conversations are git-ignored by default because they may contain
private manuscript context.

## Safety model

- Every project path from the interface is validated against the active project root.
- The agent runs with your local permissions inside the project folder; each change lands as one reversible transaction.
- Untrusted projects compile with shell escape disabled.
- A bundled prehook blocks direct bibliography writes and routes them through the `bibcite` skill.
- API keys stay in the macOS Keychain — never in project files or browser storage.
- Imported paper Markdown is sanitized before rendering.

## Architecture

The React 19 + TypeScript interface runs inside Tauri 2; Rust owns project
validation, transactions, LaTeX compilation, paper import, bibliography
changes, Overleaf sync, and the agent RPC bridge.

```text
Direct editor ─┐
Paper import ──┼──> validated project edits ──> transaction record ──> filesystem
Writing agent ─┘
```

Collaboration runs alongside on a CRDT path: files mirror into per-file Yjs
documents, sync through a small Cloudflare Worker (`collab-server/`, Durable
Objects on the free tier), and write back to disk while each peer compiles
locally. The agent panel supervises a pinned [Synara](https://github.com/leo1oel/synara)
runtime bundled into the app — see [`docs/synara-runtime.md`](docs/synara-runtime.md).

**Stack:** Tauri 2 · React 19 · Vite 7 · Tailwind CSS 4 · CodeMirror 6 · TipTap 3 ·
PDF.js · Yjs / y-partyserver · tldraw · KaTeX · Harper · rusqlite (FTS5)

## Development

```bash
# One-time: the pinned Synara source is needed to stage the agent runtime
git clone https://github.com/leo1oel/synara.git ../synara-poc
git -C ../synara-poc switch codex/lattice-embed

pnpm install
pnpm tauri dev
```

Run the full verification gate before sending changes:

```bash
pnpm check   # frontend lint + tests + build, cargo test, clippy -D warnings
```

Release: `node scripts/bump-version.mjs patch`, commit, tag `vX.Y.Z`, and push —
CI builds, signs, notarizes, publishes the GitHub Release, and updates the
auto-update feed. See [`AUTO-UPDATE-SETUP.md`](AUTO-UPDATE-SETUP.md).

To self-host collaboration, deploy the worker with `pnpm collab:login &&
pnpm collab:deploy` and point the share dialog (or `VITE_LATTICE_COLLAB_HOST`)
at your `*.workers.dev` host.

## Roadmap

- PDF text selection and annotation
- Authentication and cross-device persistence for shared rooms
- Hardened agent cancellation and recovery after interrupted agent processes
- Semantic evidence retrieval over the imported paper library

## License

Apache License 2.0. GSAP is used under its own license for interface animation
only. Bundled venue styles (NeurIPS/ICML/ICLR) keep their original provenance
and are not relicensed. Ioskeley Mono is bundled under the SIL OFL.
