# Getting started

## Install Lattice

1. Download the `.dmg` from the [latest release](https://github.com/leo1oel/lattice/releases/latest) and drag Lattice into Applications. On an Intel Mac, take the file ending in `_x64.dmg`. With Homebrew: `brew install --cask lattice`.
2. Open Lattice. It updates itself: when a new version is ready, **Lattice › Restart to Update…** installs it. You can change this in **Settings › Editor & builds › App updates**.

Lattice needs macOS 14 or later. Linux (AppImage) and Windows builds are experimental and have no Agent.

## The native Lattice on Apple silicon

On a Mac with Apple silicon, Lattice can switch to its native version, which the Mac draws itself instead of as a web page. It looks and works the same. Lattice offers the switch once after the update that brings it; **Settings › Editor & builds › Switch to the new Lattice** offers it any time after **Not now** or **Don't ask again**.

- **What comes with you:** on the first switch, your recent projects, settings, themes, plugins, project templates, Agent skills and Overleaf links. Your project folders are untouched either way.
- **What's different:** the native version checks spelling with macOS's own checker and has no grammar check or dictionaries for other languages. Past Agent threads don't show in it.
- **Switching back:** **Settings › Editor & builds › Switch back to the classic version** in the native version installs the classic one in its place. The classic version opens with its data as it was before the switch; changes made in the native version don't flow back. If you switch again later, the native version keeps its own settings, themes, plugins and Overleaf session, and adds the recent projects you opened in the classic version.

## Set up TeX

Lattice builds PDFs with your own TeX installation (MacTeX or TeX Live). If you have none, Lattice offers to install **BasicTeX** for you: it is the first step of the Get started checklist, and a build that finds no TeX offers it too. A missing LaTeX package found during a build can also be installed from the build problem itself.

To check your setup at any time, open **Settings › TeX doctor**. It lists every tool a build uses and what the open project needs (its root document, bibliography, venue packages and fonts). **Ready to compile** means you are set. If something is red, **Install required tools** installs it; adding papers and looking up citations need a small Python tool (`uv`), which the same button installs.

![The TeX doctor with every tool found: Ready to compile](images/en-tex-doctor.webp)

## Open or create a project

The project menu (the project name at the top left of the window) and the **File** menu have the same actions:

- **Open another folder** (`⌘O`): any folder with a `.tex` file. Lattice works on it in place.
- **New project** (`⌘⇧N`): name it, pick a venue template (NeurIPS, ICML, ICLR, ACL, CVPR, AAAI or a thesis class) or one of your own saved templates, then **Choose location**.
- **Clone repository…**: a Git repository from GitHub or elsewhere.
- **Open from Overleaf**: see [Overleaf sync](overleaf.md).
- **Import Overleaf ZIP…**: a project downloaded from Overleaf as a ZIP.

![The New project dialog with a name, a venue template and Choose location](images/en-new-project.webp)

Recent projects are in **File › Open Recent**. A window can hold several projects as tabs in the title bar.

## The Get started checklist

**Guided tutorial** in the project menu opens a sample paper beside **Get started**, a six-step checklist: install LaTeX, change the title and build, jump between PDF and source, cite a paper, ask the Agent to revise a paragraph, and start your own paper. Each step has **Show me**, and steps you do on your own tick themselves. You can reopen the checklist from **Panels › Get started**.

![The tutorial paper with the Get started checklist on the left and the PDF on the right](images/en-get-started.webp)
