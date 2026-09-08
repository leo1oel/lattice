<div align="center">

<a href="https://leo1oel.github.io/lattice/">
  <img src="./src-tauri/icons/app-icon.svg" alt="Lattice" width="80" />
</a>

<h1>Lattice</h1>

A local-first LaTeX workspace for macOS.

[Website](https://leo1oel.github.io/lattice/) · [Download](https://github.com/leo1oel/lattice/releases/latest) · [Docs](docs/README.md) · [Issues](https://github.com/leo1oel/lattice/issues)

[![Release](https://img.shields.io/github/v/release/leo1oel/lattice?style=flat-square&label=release&color=4568f6)](https://github.com/leo1oel/lattice/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/leo1oel/lattice/ci.yml?branch=main&style=flat-square&label=checks)](https://github.com/leo1oel/lattice/actions/workflows/ci.yml)

</div>

<p align="center">
  <img src="docs/images/lattice-hero.png" alt="A LaTeX paper in Lattice, with its source and compiled PDF side by side" width="720" />
</p>

<details>
<summary>Read more</summary>

## Features

- LaTeX completion, diagnostics, and SyncTeX navigation between source and PDF.
- Literature search, arXiv imports, and citation insertion.
- Markdown notes, whiteboards, diagrams, and spreadsheets.
- Shared cursors, comments, chat, and Git history.
- An AI agent that can read your papers, help with build errors, and make edits for you to review.

## Get started

Lattice runs on Apple Silicon Macs with macOS 14 or later.
Official builds are signed and notarized by Apple.

1. Open the [latest release](https://github.com/leo1oel/lattice/releases/latest) and download the `.dmg` under **Assets**, below the release notes.
2. Open the DMG and drag Lattice into Applications.
3. Launch Lattice and open a folder, choose a template, or connect an Overleaf project.

## Your files and privacy

Your project is a folder of ordinary files on your Mac, so you can use another editor or Git without exporting anything.
Keep `.research/` alongside your files to preserve imported papers and agent sessions.

Lattice Shares sends shared document text, file names and paths, assets, chat, comments, and presence through `lattice-collab.paperlattice.workers.dev`.
This maintainer-run service has no uptime or privacy guarantee; unshared projects don't use it.
You can [host your own server](collab-server/README.md) and choose it in **Live collaboration → Advanced (sync host)**.

## Contributing

Lattice uses Tauri 2, Rust, React, and TypeScript.
See [CONTRIBUTING.md](CONTRIBUTING.md) to build the app and run tests, or browse the [architecture docs](docs/README.md).
Bug reports and pull requests are welcome; please open an [issue](https://github.com/leo1oel/lattice/issues) before a large refactor.

## License

Lattice is [GPL-3.0-or-later](LICENSE), with code from [Inkeep Open Knowledge](https://github.com/inkeep/open-knowledge) and the MIT-licensed [Synara](https://github.com/Emanuele-web04/synara) agent runtime by T3 Tools Inc. and Emanuele Di Pietro.
See [third-party notices](THIRD_PARTY_NOTICES.md) for component licenses and [Synara integration notes](docs/synara-runtime.md) for the runtime details.

The whiteboard's tldraw SDK has a source-available license that is not GPL-compatible.
Its compatibility with Lattice's GPLv3 distribution remains unresolved; read the notices before redistributing a build.

</details>
