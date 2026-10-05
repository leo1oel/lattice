<div align="center">

<a href="https://leo1oel.github.io/lattice/">
  <img src="./src-tauri/icons/app-icon.svg" alt="Lattice" width="80" />
</a>

<h1>Lattice</h1>

The LaTeX workspace for macOS that keeps your paper on your Mac.

[Download](https://github.com/leo1oel/lattice/releases/latest) · [Website](https://leo1oel.github.io/lattice/) · [Docs](docs/README.md) · [Issues](https://github.com/leo1oel/lattice/issues)

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?style=flat-square&label=release&color=4568f6)](https://github.com/leo1oel/lattice/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/leo1oel/lattice/ci.yml?branch=main&style=flat-square&label=checks)](https://github.com/leo1oel/lattice/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-4568f6?style=flat-square)](LICENSE)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/lattice-hero-dark.png" />
    <img src="docs/images/lattice-hero.png" alt="Lattice with a LaTeX paper open: the project and Papers panels on the left, the source in the middle, the compiled PDF on the right" width="820" />
  </picture>
</p>

Source, PDF, papers and an AI agent share one window, and you arrange them the way you work.
Lattice is native to macOS and fast with long documents. It works offline, and your project stays an ordinary folder you can open in any other editor or put under Git.

- **Write LaTeX.** Completion, diagnostics, one-click builds and SyncTeX jumps between source and PDF.
- **Shape your workspace.** Dock any panel anywhere, switch between Writing and Reading layouts, and save your own named workspaces.
- **Keep your papers close.** Search the literature, import from arXiv, a DOI or a webpage, read beside your notes and cite in one step.
- **Work with an agent.** The built-in agent reads your project and papers, fixes build errors, and proposes edits you review before they land.
- **Write with others.** Two-way Overleaf sync with live cursors, chat, comments and tracked changes, plus Git history for every file.
- **Go beyond `.tex`.** Markdown notes, whiteboards, spreadsheets and slides live in the same project.

New to Lattice? Open **Guided tutorial** from the project menu for a one-minute tour of a sample paper.

## Install

Lattice runs on Apple Silicon Macs with macOS 14 or later, and builds with your own [MacTeX](https://tug.org/mactex/) or TeX Live.
Download the `.dmg` from the [latest release](https://github.com/leo1oel/lattice/releases/latest), drag Lattice into Applications, and open a folder, start from a template, or connect an Overleaf project.
Official builds are signed, notarized by Apple, and update themselves.

To build from source or contribute, see [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture docs](docs/README.md).
Bug reports and pull requests are welcome; please open an [issue](https://github.com/leo1oel/lattice/issues) before a large refactor.

## Acknowledgements

Lattice stands on many open-source projects. The major ones:

- [Open Knowledge](https://github.com/inkeep/open-knowledge) (inkeep/open-knowledge) by Inkeep, the original basis of Lattice's earlier visual Markdown editor. Lattice has since replaced it with its own engine, but the editor began there, and we are grateful.
- [Trellis](https://github.com/DanFessler/trellis) by Dan Fessler, the dockable panel layout of Lattice's workspace. Uses Trellis by DanFessler - github.com/DanFessler/trellis.
- [Synara](https://github.com/Emanuele-web04/synara) by T3 Tools Inc. and Emanuele Di Pietro, the agent runtime behind Lattice's AI assistant.
- [Open Slide](https://github.com/open-slide/open-slide), which powers presentations.
- [Tiptap](https://github.com/ueberdosis/tiptap) and [CodeMirror](https://codemirror.net/), the rich-text and source editors.
- [PDF.js](https://github.com/mozilla/pdf.js), the PDF viewer.
- [Tauri](https://github.com/tauri-apps/tauri), the desktop shell.

## License

Lattice is licensed under the [Apache License 2.0](LICENSE) (see also [NOTICE](NOTICE)), with the MIT-licensed [Synara](https://github.com/Emanuele-web04/synara) agent runtime by T3 Tools Inc. and Emanuele Di Pietro.
Releases up to and including 0.1.341 were GPL-3.0-or-later and remain available under those terms.
See [third-party notices](THIRD_PARTY_NOTICES.md) for component licenses and [Synara integration notes](docs/synara-runtime.md) for the runtime details.

Two components carry their own terms:

- The whiteboard's tldraw SDK (`tldraw`, `@tldraw/editor`, `@tldraw/driver`) is source-available under the [tldraw license](public/licenses/tldraw-LICENSE.md), which requires a license key for production use. Official builds supply that key at build time; it is not in this repository, so a build without it runs tldraw in its watermarked mode.
- The workspace's panel layout, `@danfessler/trellis` (with `@danfessler/trellis-react`), is under its own non-commercial license with a commercial tier: see [its license](public/licenses/trellis-LICENSE.md), the [non-commercial terms](public/licenses/trellis-LICENSE-NONCOMMERCIAL.md) and the [commercial terms](public/licenses/trellis-LICENSE-COMMERCIAL.md). Those terms apply to anyone using Lattice: the free tier covers non-commercial use only, so use at a company or a for-profit organization needs a Trellis license from its author. Uses Trellis by DanFessler - github.com/DanFessler/trellis.
