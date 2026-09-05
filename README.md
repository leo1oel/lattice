<div align="center">

<img src="./src-tauri/icons/app-icon.svg" alt="Lattice app icon" width="112" />

# Lattice

A local-first LaTeX workspace for macOS.
Write papers with a live PDF preview, keep notes and references alongside them, and collaborate through Lattice or Overleaf.

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?label=release&color=4568f6)](https://github.com/leo1oel/lattice/releases/latest)
[![Platform](https://img.shields.io/badge/macOS-Apple%20Silicon-202124?logo=apple&logoColor=white)](https://github.com/leo1oel/lattice/releases/latest)
[![License](https://img.shields.io/badge/license-GPL--3.0--or--later-25b4bb)](LICENSE)

[**Download for macOS**](https://github.com/leo1oel/lattice/releases/latest) · [Get started](#get-started) · [Documentation](docs/README.md) · [Report an issue](https://github.com/leo1oel/lattice/issues)

<img src="docs/images/lattice-hero.png" alt="Lattice editing a LaTeX paper with the compiled PDF beside it" width="900" />

</div>

## What you can do

- Write LaTeX with completion, diagnostics, a live PDF preview, and SyncTeX navigation between source and output.
- Keep Markdown notes, whiteboards, diagrams, and spreadsheets in the same project.
- Import papers from arXiv, search literature, read cached papers, and insert citations.
- Collaborate with live cursors, comments, and chat through Lattice Shares, or sync with an existing Overleaf team.
- Review changes, compare revisions, and restore earlier work with built-in Git history.
- Ask an AI agent about your document, selection, papers, or build errors, and review its project edits.

The agent uses [Synara](https://github.com/Emanuele-web04/synara), an MIT-licensed runtime by T3 Tools Inc. and Emanuele Di Pietro, with Lattice's research tools.
Choose your provider, model, tools, and permissions in Agent settings.
See the [runtime documentation](docs/synara-runtime.md) for the pinned fork and integration details.

## Get started

Official builds support **Apple Silicon Macs running macOS 14 or later** and are signed and notarized by Apple.

1. [Download the latest release](https://github.com/leo1oel/lattice/releases/latest), open the DMG, and drag Lattice into Applications.
2. Install a TeX distribution that provides `latexmk`; Lattice checks for missing tools on first launch.
3. Create a project from a conference template, open an existing folder, or connect an Overleaf project.
4. Press `Cmd+S` to save and compile.

Lattice checks for updates automatically.
See [release notes](https://github.com/leo1oel/lattice/releases) for changes.

## Your files and privacy

Projects are ordinary `.tex`, `.bib`, Markdown, and asset files in a folder on your Mac.
You can use another editor, compile from the command line, or manage the folder with Git without exporting anything.
Keep the project's `.research/` directory to preserve Lattice-specific data such as imported papers and agent sessions.

**Lattice Shares uses a sync server.**
While sharing, document text, file names and paths, shared assets, chat, comments, and presence information pass through `lattice-collab.paperlattice.workers.dev`.
The maintainer operates this server without an uptime or privacy guarantee; projects you aren't sharing don't use it.
You can [deploy your own sync server](collab-server/README.md) and set its address in **Live collaboration → Advanced (sync host)**, or configure `VITE_LATTICE_COLLAB_HOST` for your builds.

## Development

Lattice uses Tauri 2, Rust, React, and TypeScript.
Install [mise](https://mise.jdx.dev), Rust, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```bash
mise install
pnpm install
mkdir -p src-tauri/{synara-runtime,chromium-runtime}
touch src-tauri/{synara-runtime,chromium-runtime}/placeholder.txt
pnpm check
pnpm dev  # frontend only
```

The placeholders are enough for checks and tests.
Running the desktop app with `pnpm tauri dev` requires the pinned Synara source; follow the [desktop setup instructions](CONTRIBUTING.md#running-the-full-desktop-app).

- [Contributing](CONTRIBUTING.md): setup, tests, and pull requests.
- [Architecture and subsystem docs](docs/README.md): where the code lives and how it works.
- [Release process](docs/release-process.md): packaging, signing, and builds from forks.
- [Issues](https://github.com/leo1oel/lattice/issues): bug reports and feature requests.

## License

Lattice is licensed under [GPL-3.0-or-later](LICENSE) and incorporates GPL code from [Inkeep Open Knowledge](https://github.com/inkeep/open-knowledge).
Bundled components retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) for attribution and known gaps.

The whiteboard's **tldraw SDK uses a source-available license that is not GPL-compatible**.
The consequences of combining it with Lattice's GPLv3 terms remain unresolved; read the notices before redistributing a build.
