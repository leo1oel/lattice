# Lattice

Lattice is a local-first, agent-first scientific LaTeX writing environment for macOS.
It keeps the project folder authoritative while connecting direct LaTeX editing, rendered PDF review, imported arXiv evidence, citation management, and local Codex or Claude sessions in one desktop application.

This repository contains an early working prototype.
It is intended to validate the complete writing loop before collaboration and hosted services are added.

## What works today

- Create a new research project or open an existing LaTeX folder.
- Start new projects with the official NeurIPS 2026 preprint style and a concise research-paper skeleton.
- Browse, create, delete, scroll, and directly edit project source files with a full-height CodeMirror canvas; new source files automatically receive a `.tex` suffix and reject unsupported extensions.
- Write in a softly tinted CodeMirror canvas with MonoLisa as the default editor font and parser-aware LaTeX highlighting derived from the Lux Light palette.
- Get automatic braces after citation commands and bibliography-key completion inside `\\cite{...}`.
- Compile the default root document with the local `latexmk` installation, including an immediate build whenever a project is entered.
- Choose manual builds or automatic builds that run when you leave the editor or pause typing for 1.2 seconds.
- Review the generated PDF beside the source with a draggable split divider and a themed PDF.js toolbar for paging, zoom, native Save As export, and click-to-source SyncTeX navigation.
- Drag PNG, JPEG, PDF, SVG, EPS, or WebP figures onto a project folder, or import them through the figures-folder action.
- Click a project figure to preview it in the writing canvas, or drag it from Project onto a LaTeX line to insert an editable `figure` block at that position.
- Drop an external figure directly onto the LaTeX editor to import and insert it in one step; SVG and WebP sources are converted to shareable PDF or PNG companions for reliable LaTeX builds.
- Import an arXiv paper as Markdown with `arxiv2md`.
- Add every imported paper to the project bibliography through `bibcite`.
- Browse imported papers by title, read their Markdown snapshots, and remove a paper together with its `bibcite`-managed bibliography entry. Re-adding the same arXiv paper, including another version URL, reuses the existing import without touching the project.
- Ask a local Codex or Claude Code session to make evidence-aware project edits while its visible response streams into the conversation.
- Manage bundled, all-project, and project-only skills from Settings, including adding, editing, disabling, deleting, and restoring overrides without installing anything into a global agent directory.
- Search OpenAlex for candidate related work on demand while keeping discovery metadata separate from evidence that is safe to cite.
- Use an OpenAI or Anthropic API key with the same streamed response experience instead of a local subscription.
- Switch between Codex and Claude between messages, with current full model names and model-specific reasoning-effort controls for subscriptions and APIs.
- Inspect and start Codex or Claude subscription login from Settings without configuring an API key.
- Create, search, restore, and delete project-local agent conversations, or edit an earlier user message to continue on a new Pi branch while restoring the project files to that turn and preserving the original conversation.
- Save direct edits, imports, and agent changes as atomic project transactions, retaining the latest 100 entries per project.
- Inspect project history and revert a transaction.
- Resize the Project and Papers regions vertically and preserve that layout across launches.
- Drag the macOS window from non-interactive title-bar space, with native traffic lights aligned to the project controls.
- Choose the light or dark theme, interface and editor fonts, scale the entire interface from 90% to 135%, and set editor text from 10 to 24 pixels in Settings, with a more readable 110% default scale and reduced-motion support.

## Current boundaries

This prototype does not yet implement realtime collaboration, CRDT synchronization, cloud accounts, source-to-PDF SyncTeX navigation, a full ACP agent adapter, MCP tool exposure, or semantic embeddings.
The local agent experience is a Pi harness with project tools, application-local skills, optional user-owned system prompts, and a bibliography prehook that redirects `.bib` edits through `bibcite`.
Imported paper retrieval is currently a lightweight lexical ranking over project snapshots.

## Prerequisites

The desktop application currently targets macOS.
Install the following tools before running it:

- Node.js and `pnpm`.
- Rust and Cargo.
- MacTeX or TeX Live with `latexmk`.
- `uv`, which runs `arxiv2md` and provides the `bibcite` fallback.
- A logged-in Codex CLI, Claude Code CLI, an OpenAI API key, or an Anthropic API key for agent writing.

Installing `bibcite` as a persistent tool avoids its one-time fallback startup cost:

```bash
uv tool install bibcite-cli
```

## Quick start

```bash
pnpm install
pnpm tauri dev
```

Choose **New project** to create a NeurIPS 2026-style preprint, bibliography, project brief, and private transaction and conversation history.
Choose **Open folder** to import an existing LaTeX directory.

Press `Cmd+S` to save and build, or use the build button in the title bar.
Paste an arXiv URL into the paper importer to add a Markdown snapshot and bibliography entry.
Select LaTeX text before sending a message when the agent should focus on a specific passage.
Use the project heading's plus button to add a LaTeX file or folder, and the row actions to remove project entries or imported papers.
Right-click the project heading, any project entry, or an imported paper and choose **Show in Finder** to reveal its local file.
The `.tex` suffix is optional while naming a new source file and is added automatically.
Drag figure files anywhere over the Project pane to add them to `figures`, or drop them directly on another project directory to target that folder.
Choose the agent model and effort directly above the conversation; the selection is saved with each project-local conversation.
Open Settings to enlarge the interface, adjust fonts, choose automatic build behavior, inspect subscription login, or manage API keys.
The key icon only appears for OpenAI API and Anthropic API providers and stores those keys in macOS Keychain.

## Project format

Lattice preserves normal LaTeX files and adds a small human-readable sidecar:

```text
paper-project/
├── main.tex
├── neurips.sty
├── references.bib
├── figures/
└── .research/
    ├── project.json
    ├── brief.md
    ├── papers/<arxiv-id>/paper.md
    ├── history/<transaction-id>.json
    └── sessions/<conversation-id>.json
```

The manuscript remains buildable if `.research` is removed.
The sidecar contains application metadata, the durable research brief, imported evidence, local undo history, and agent conversations.
History and conversations are ignored by the generated `.gitignore` because they may contain private manuscript context.
The bundled source is the supplied NeurIPS 2026 style; new projects receive it as `neurips.sty` with the internal package name adjusted to match.
That package did not include a separate license file, so Lattice records its provenance without assigning it the repository's Apache-2.0 license.

## Safety model

Every path accepted from the interface or an agent is validated against the active project root.
An agent cannot write outside the project or modify transaction history.
Untrusted projects compile with shell escape disabled.
Agent CLIs run in read-only mode and return complete structured edits, which the application validates and commits as one transaction.
Direct API keys are stored in macOS Keychain and never enter project files or browser storage.
Paper Markdown is sanitized before rendering.

## Architecture

The React and TypeScript interface runs inside Tauri 2.
Rust owns filesystem access, project validation, transactions, subprocess execution, LaTeX compilation, paper import, bibliography changes, and agent bridges.

The central boundary is the document transaction layer:

```text
Direct editor ─┐
Paper import ──┼──> validated project edits ──> transaction record ──> filesystem
Writing agent ─┘
```

This boundary is designed to become the `DocumentStore` abstraction used by later CRDT collaboration.
ACP should connect complete external agents to Lattice, while MCP should expose Lattice project tools to those agents.
Neither protocol is required to validate the prototype's local writing loop.

## Development

Run the complete local verification suite with:

```bash
pnpm check
```

The suite runs frontend linting, frontend tests, a production web build, Rust unit tests, and Clippy with warnings treated as errors.

Build the macOS application bundle with:

```bash
pnpm tauri build
```

## Next milestones

1. Replace the subprocess-specific agent bridge with ACP adapters and expose project operations through MCP.
2. Add PDF selection and annotation plus source-to-PDF SyncTeX navigation.
3. Add TexLab diagnostics and completion to the source editor.
4. Add SQLite FTS5 indexing and evaluate a PaperQA2 sidecar for semantic evidence retrieval.
5. Add one-click switching from the bundled NeurIPS 2026 style to current ICML, ICLR, and other venue templates.
6. Harden skill import upgrades, on-demand figure downloads, provenance sidecars, and failure recovery.
7. Introduce a CRDT-backed `DocumentStore` behind the existing transaction interface before adding collaboration UI.

## License

Lattice is licensed under the Apache License 2.0.
GSAP is distributed under its own license and is used only for interface animation.
