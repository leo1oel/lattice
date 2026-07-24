# Lattice

A local-first, agent-first LaTeX writing environment for scientific papers, built for macOS.

Lattice keeps your project folder authoritative and puts direct LaTeX editing, rendered PDF review, imported arXiv evidence, citation management, real-time collaboration, and a local Codex or Claude agent in one desktop app.
The manuscript stays a normal LaTeX project on disk, so nothing here locks you in.

This is an early but working build.
It targets Apple Silicon Macs and ships signed auto-updates.

## Features

### Writing and editing

- Create a new project from the bundled NeurIPS 2026 preprint style and a concise paper skeleton, or open an existing LaTeX folder.
- Edit source in a soft-wrapping CodeMirror canvas with parser-aware LaTeX highlighting, optional Vim or Emacs keymaps, and automatic `.tex` suffixing for new files.
- Get braces after citation commands, key completion inside `\cite{...}`, citation metadata on `\cite` hover, and `\ref` hover previews for figures, tables, equations, and sections, including first-page thumbnails for PDF figures.
- Compile the root document with your local `latexmk`, either manually or automatically when you leave the editor or pause typing for 1.2 seconds.

### PDF review

- Read every generated page in one continuously scrolling column beside the source, with a draggable split divider.
- Navigate, zoom, and export through a themed PDF.js toolbar, and click a rendered line to jump back to its source with SyncTeX.

### Figures

- Drag PNG, JPEG, PDF, SVG, EPS, or WebP files onto a project folder, or add them through the figures action.
- Click a figure to preview it in the canvas, or drag it onto a LaTeX line to insert an editable `figure` block at that spot.
- SVG and WebP sources are converted to PDF or PNG companions so the LaTeX build stays reliable.

### Papers and citations

- Import an arXiv paper as Markdown with `arxiv2md` and add it to the bibliography through `bibcite`.
- Browse imported papers by title, read their Markdown snapshots, and remove a paper together with its bibliography entry.
- Re-adding the same arXiv paper, including a different version URL, reuses the existing import instead of touching the project.
- Search project filenames, source contents, and imported paper titles from one navigator field, with punctuation-tolerant multi-word matching.
- Search OpenAlex for candidate related work on demand, kept separate from evidence that is safe to cite.

### Live collaboration

- Share an open project in real time over a CRDT, so edits, figures, papers, and inline comments sync as everyone types, including each other's named cursors in the editor.
- Guests join from an invite into a fresh folder under `Documents/Lattice Shares`, and their other local projects are never touched.
- Each room is protected by a secret token in the invite, the shared document is persisted on the server, and idle rooms are reclaimed automatically.
- Reopen a recent share from the dialog to rejoin without pasting an invite again.
- The PDF stays local, so each machine rebuilds it after sync.

### The writing agent

- Ask a local Codex or Claude Code session to make evidence-aware edits while its response streams into the conversation.
- Switch between Codex and Claude between messages, with current model names and model-specific reasoning-effort controls.
- Sign in through Oh My Pi from Settings, or use your own OpenAI or Anthropic API key stored in the macOS Keychain.
- Manage bundled, all-project, and project-only skills from Settings without installing anything into a global agent directory.
- Create, search, restore, and delete project-local conversations, copy any message, or edit an earlier message to branch a new attempt while restoring the project files to that turn.

### History and layout

- Every direct edit, import, and agent change is saved as one reversible transaction, keeping the latest 100 per project.
- Inspect the project history and revert any transaction.
- The layout is remembered across launches, including panel sizes, whether the navigator or agent is collapsed, and the file you last had open in each project.
- Choose light or dark theme, interface and editor fonts, interface scale from 90% to 135%, and editor text from 10 to 24 pixels, with reduced-motion support.

## Tech stack

- **Desktop shell:** Tauri 2, a Rust core driving the system WebView. Auto-updates run through `tauri-plugin-updater`, and API keys live in the macOS Keychain via `keyring`.
- **Frontend:** React 19 and TypeScript, bundled with Vite 7. Tailwind CSS v4 for styling, Motion and GSAP for animation, Radix UI primitives, and lucide-react icons.
- **Editor:** CodeMirror 6 with `codemirror-lang-latex`, optional Vim and Emacs keymaps, and `y-codemirror.next` for collaborative cursors.
- **PDF and math:** `pdfjs-dist` renders the PDF; `katex`, `marked`, and `dompurify` render and sanitize imported paper Markdown.
- **Collaboration:** Yjs with `y-protocols` and `y-partyserver`, synced through a Cloudflare Worker backed by a SQLite Durable Object (the `collab-server/` package).
- **Rust backend:** project validation, transactions, subprocess execution, LaTeX compilation, paper import, and the agent bridge, using `serde`, `reqwest`, `rusqlite`, `walkdir`, `chrono`, and `objc2` for native macOS window details.
- **Agent runtime:** Oh My Pi (`@oh-my-pi/pi-coding-agent`) for model access, streaming, tools, and conversation branching across Codex and Claude.
- **Tooling:** Vitest and Testing Library, ESLint with typescript-eslint, and `cargo test` with Clippy.

## Getting started

Lattice targets macOS.
Install these first:

- Node.js and `pnpm`.
- Rust and Cargo.
- MacTeX or TeX Live with `latexmk`.
- `uv`, which runs `arxiv2md` and provides the `bibcite` fallback.
- A Codex or Claude subscription signed in through Oh My Pi, or an OpenAI or Anthropic API key.

Installing `bibcite` as a persistent tool avoids its one-time fallback startup cost:

```bash
uv tool install bibcite-cli
```

Then run the app:

```bash
pnpm install
pnpm tauri dev
```

Choose **New project** for a NeurIPS 2026 preprint with a bibliography, brief, and private history, or **Open folder** to import an existing LaTeX directory.
Press `Cmd+S` to save and build, or use the build button in the title bar.
Paste an arXiv URL into the paper importer to add a Markdown snapshot and bibliography entry.
Select LaTeX text before sending a message when the agent should focus on a passage.

## Live collaboration setup

Sharing runs on a small Cloudflare Worker in `collab-server/`.
The app ships pointing at a default host, so most people never touch this.

To run your own sync server, deploy the worker to your Cloudflare account and point the app at it:

```bash
pnpm collab:login    # one-time wrangler login
pnpm collab:deploy   # deploy the worker
```

Then paste the resulting `*.workers.dev` host into the dialog under Advanced, or set `VITE_LATTICE_COLLAB_HOST` before building.
The worker uses Durable Objects with the free-tier SQLite storage backend, so a small deployment costs nothing.

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
    ├── sessions/<conversation-id>.json
    ├── omp-sessions/<omp-session>.jsonl
    └── omp-session-map/<conversation-id>.json
```

The manuscript still builds if `.research` is removed.
The sidecar holds application metadata, the research brief, imported evidence, local undo history, and agent conversations.
History and conversations are git-ignored because they may contain private manuscript context.
New projects receive the bundled NeurIPS 2026 style as `neurips.sty`, with its provenance recorded rather than relicensed under the repository's Apache-2.0 license.

## Safety model

- Every project path from the interface is validated against the active project root.
- The agent runs with your local permissions and the project folder as its working directory, and each resulting change is recorded as one reversible transaction.
- Untrusted projects compile with shell escape disabled.
- A bundled prehook blocks direct bibliography writes and routes them through the `bibcite` skill instead.
- API keys stay in the macOS Keychain and never enter project files or browser storage.
- Imported paper Markdown is sanitized before rendering.

## Architecture

The React and TypeScript interface runs inside Tauri 2.
Rust owns project validation, transactions, subprocess execution, LaTeX compilation, paper import, bibliography changes, and the agent RPC bridge.

Local edits flow through one document transaction layer:

```text
Direct editor ─┐
Paper import ──┼──> validated project edits ──> transaction record ──> filesystem
Writing agent ─┘
```

Collaboration runs alongside this on a separate CRDT path.
The desktop app mirrors project files into a Yjs document, syncs it through the Cloudflare Worker, and writes remote changes back to disk, while each peer compiles the PDF locally.
Oh My Pi is the agent backend, and Lattice keeps the UI, projects, editor, paper library, PDF review, and collaboration as the product-owned layers.

## Development

Run the full local verification suite:

```bash
pnpm check
```

This runs frontend lint, frontend tests, a production web build, Rust unit tests, and Clippy with warnings treated as errors.

Build the macOS application bundle:

```bash
pnpm tauri build
```

## Roadmap

- Harden agent cancellation, tool-progress rendering, and recovery after an interrupted agent process.
- Add PDF selection and annotation, and source-to-PDF SyncTeX navigation.
- Add TexLab diagnostics and completion to the editor.
- Add SQLite FTS5 indexing and evaluate a semantic evidence-retrieval sidecar.
- Add one-click switching from the NeurIPS 2026 style to ICML, ICLR, and other venue templates.
- Add authentication and cross-device persistence to shared rooms.

## License

Lattice is licensed under the Apache License 2.0.
GSAP is distributed under its own license and is used only for interface animation.
The bundled NeurIPS 2026 style keeps its original provenance and is not relicensed.
