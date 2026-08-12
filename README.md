<div align="center">

<img src="./src-tauri/icons/app-icon.svg" alt="Lattice app icon" width="112" />

# Lattice

**A local research workspace for writing, reading, thinking, and collaborating.**

Lattice brings LaTeX, visual notes, whiteboards, papers, version history,
collaboration, and an AI research agent together in one macOS app.

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?label=release&color=4568f6)](https://github.com/leo1oel/lattice/releases/latest)
[![Platform](https://img.shields.io/badge/macOS-Apple%20Silicon-202124?logo=apple&logoColor=white)](https://github.com/leo1oel/lattice/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-25b4bb)](LICENSE)

[**Download for macOS**](https://github.com/leo1oel/lattice/releases/latest) ·
[Get started](#get-started) ·
[Explore the features](#one-workspace-for-the-whole-research-process) ·
[Get help](https://github.com/leo1oel/lattice/issues)

</div>

---

Research rarely happens in a single editor. A paper moves between LaTeX,
PDFs, notes, sketches, references, collaborators, Git, and increasingly AI.
Lattice keeps that work connected without taking it away from your computer or
turning your manuscript into a proprietary document.

At its core, Lattice is a local LaTeX editor and compiler. Around it is a
complete research companion: a Notion-like Markdown editor, visual whiteboards,
literature management, collaboration, project history, and an agent that can
work with the context of your project.

## One workspace for the whole research process

### ✍️ Write papers, notes, and ideas side by side

Edit LaTeX with completion and diagnostics while the PDF updates beside your
source. Jump between source and output with SyncTeX, search and annotate the
PDF, and export it when it is ready.

Research does not begin and end in LaTeX, so the same project can also hold
rich Markdown notes, diagrams, and free-form whiteboards. Use them for reading
notes, outlines, derivations, figures, or early ideas without opening a second
workspace.

### 👥 Collaborate with Lattice or Overleaf

Share a Lattice project for realtime editing, cursors, comments, project chat,
and shared assets. Every collaborator keeps a working copy of the project on
their own computer.

Already working with an Overleaf team? Open and sync Overleaf projects from
Lattice, collaborate through Overleaf's live channel, and work with comments,
chat, tracked changes, and project history without abandoning your existing
workflow.

### 🕘 See how the project changed

Built-in Git support keeps the evolution of a paper visible. Browse history,
inspect file-level changes, compare revisions, and restore earlier work from
inside the app. Agent edits are also reviewable and backed by checkpoints, so
experimentation does not have to mean losing a good draft.

### 🤖 Work with an AI research agent

Ask questions without repeatedly pasting your manuscript into a chat window.
The agent can work with the active document, selected text, imported papers,
and build context. Use it to explore an idea, understand a source, improve a
passage, or make reviewable changes across the project.

You choose the provider, model, tools, and permission mode from the Agent
settings in Lattice.

### 📚 Manage citations and papers together

Keep references and reading material in one library instead of separating the
`.bib` file from the papers it describes. Import work from arXiv, search related
literature, read cached paper snapshots, preview references, and insert
citations while writing.

Lattice connects the citation in your manuscript to the paper you want to
understand, making literature review and writing part of the same workflow.

## Get started

Official builds currently support **Apple Silicon Macs running macOS 14 or
later**. Downloads are signed and notarized by Apple and update automatically.

1. **[Download the latest release](https://github.com/leo1oel/lattice/releases/latest)**,
   open the DMG, and drag Lattice into Applications.
2. Install a TeX distribution that provides `latexmk`. On first launch,
   Lattice checks your local TeX setup and helps identify missing tools.
3. Choose **New project** to start from a conference template, **Open folder**
   for an existing LaTeX project, or open a project from Overleaf.
4. Press `Cmd+S` to save and compile. The editor and PDF preview stay together
   as you write.

From there, try the workflow that matches your project:

- Add a Markdown note or whiteboard for planning and reading notes.
- Import an arXiv URL to add a paper and citation to your library.
- Select a passage before asking the agent a question to give it precise context.
- Open **Live collaboration** to share with another Lattice user.
- Connect Overleaf to bring an existing collaborative project into Lattice.
- Open **History** to review or restore earlier changes.

## Your project stays portable

Lattice works with ordinary `.tex`, `.bib`, Markdown, and asset files in a real
folder on your Mac. You can continue to open the project in another editor,
compile it from the command line, commit it with Git, or upload it elsewhere.
There is no export step and no proprietary manuscript format.

Lattice-specific information such as imported papers, project history, and
agent sessions lives in the project's `.research/` directory. Keep that
directory if you want those parts of the workspace to move with the project.

## Feedback and contributions

Found a bug or have an idea that would improve the research workflow? Please
[open an issue](https://github.com/leo1oel/lattice/issues). Code and
documentation contributions are welcome; see the
[contributing guide](CONTRIBUTING.md) before opening a pull request.

## License

Lattice is licensed under the [Apache License 2.0](LICENSE). Bundled and adapted
components retain their own licenses; see the
[third-party notices](THIRD_PARTY_NOTICES.md) for details.
