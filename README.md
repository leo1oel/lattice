# Lattice

Lattice is a local-first, agent-first scientific LaTeX writing environment for macOS.
It keeps the project folder authoritative while connecting direct LaTeX editing, rendered PDF review, imported arXiv evidence, citation management, and local Codex or Claude sessions in one desktop application.

This repository contains an early working prototype.
It is intended to validate the complete writing loop before collaboration and hosted services are added.

## What works today

- Create a new research project or open an existing LaTeX folder.
- Start new projects with a bundled, MIT-licensed arXivTeX two-column template.
- Browse, create, delete, and directly edit project source files with CodeMirror; new source files automatically receive a `.tex` suffix and reject unsupported extensions.
- Get automatic braces after citation commands and bibliography-key completion inside `\\cite{...}`.
- Compile the default root document with the local `latexmk` installation.
- Review the generated PDF beside the source with a draggable split divider.
- Import an arXiv paper as Markdown with `arxiv2md`.
- Add every imported paper to the project bibliography through `bibcite`.
- Browse imported papers by title, read their Markdown snapshots, and remove a paper together with its `bibcite`-managed bibliography entry.
- Ask a local Codex or Claude Code session to make evidence-aware project edits.
- Use an OpenAI or Anthropic API key instead of a local subscription.
- Switch between Codex and Claude between messages, with current full model names and model-specific reasoning-effort controls for subscriptions and APIs.
- Inspect and start Codex or Claude subscription login from Settings without configuring an API key.
- Create, restore, and delete project-local agent conversations with prior messages included as context.
- Save direct edits, imports, and agent changes as atomic project transactions.
- Inspect project history and revert a transaction.
- Choose interface and editor fonts and editor font size from Settings, alongside light and dark themes with reduced-motion support.

## Current boundaries

This prototype does not yet implement realtime collaboration, CRDT synchronization, cloud accounts, PDF-to-source selection through SyncTeX, a full ACP agent adapter, MCP tool exposure, or semantic embeddings.
The local agent bridge uses a constrained structured-edit response and applies validated changes through the application's transaction layer.
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

Choose **New project** to create an arXivTeX paper, bibliography, project brief, and private transaction and conversation history.
Choose **Open folder** to import an existing LaTeX directory.

Press `Cmd+S` to save and build, or use the build button in the title bar.
Paste an arXiv URL into the paper importer to add a Markdown snapshot and bibliography entry.
Select LaTeX text before sending a message when the agent should focus on a specific passage.
Use the project heading's plus button to add a LaTeX file or folder, and the row actions to remove project entries or imported papers.
The `.tex` suffix is optional while naming a new source file and is added automatically.
Choose the agent model and effort directly above the conversation; the selection is saved with each project-local conversation.
Open Settings to adjust fonts, inspect or start subscription login, or manage API keys.
The key icon only appears for OpenAI API and Anthropic API providers and stores those keys in macOS Keychain.

## Project format

Lattice preserves normal LaTeX files and adds a small human-readable sidecar:

```text
paper-project/
├── main.tex
├── main.cls
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
2. Replace the embedded browser PDF viewer with PDF.js selection, annotation, and bidirectional SyncTeX navigation.
3. Add TexLab diagnostics and completion to the source editor.
4. Add SQLite FTS5 indexing and evaluate a PaperQA2 sidecar for semantic evidence retrieval.
5. Add current official venue-template conversion for NeurIPS, ICML, ICLR, and other target conferences.
6. Add controlled project-local skills and harden import upgrades, on-demand figure downloads, provenance sidecars, and failure recovery.
7. Introduce a CRDT-backed `DocumentStore` behind the existing transaction interface before adding collaboration UI.

## License

Lattice is licensed under the Apache License 2.0.
GSAP is distributed under its own license and is used only for interface animation.
