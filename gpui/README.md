# Lattice on GPUI (preview)

A native GPUI version of Lattice's LaTeX writing flow, growing beside the Tauri app in this repository.
The Tauri app in `../src` and `../src-tauri` keeps shipping; nothing here is built, tested or released with it, and `gpui/` is its own Cargo workspace.

Its backend is the Tauri app's own: `lattice-core` (`../src-tauri/lattice-core`), the crate both apps share.
What it does so far, and nothing more, one line per feature, each with its own page under [`docs/`](docs/):

- [Agent](docs/agent.md): runs the Agent as the Tauri app embeds it, with its Git workspace and its document tools.
- [Annotations](docs/annotations.md): keeps the writer's notes on passages of the sources, marked and pinned in the editor and listed in the Annotations panel.
- [App updater](docs/updater.md): updates the app as the Tauri app does, from the GPUI app's own release channel, once Settings › Editor & builds › Beta updates is on (off by default).
- [App's log and Help](docs/app-log-and-help.md): the app's log, Settings › Logs, Report a problem and What's new.
- [Boards, spreadsheets and decks](docs/structured-documents.md): opens boards, spreadsheets and Open Slide decks in the Tauri app's own editors.
- [Builds](docs/builds.md): builds with lattice-core's latexmk build, explains its errors and offers their fixes.
- [Commands, windows and project tabs](docs/commands.md): every command from the palette, the keymap, the shortcut sheet and the menu bar; projects in new windows or as tabs.
- [Figures and tables](docs/figures-and-tables.md): the table generator, managed tables, and figures dropped from the tree or Finder, or pasted from the clipboard.
- [Finding things in the project](docs/find.md): find and replace in the open file, quick open, Find and Replace in project, and the files visited.
- [Get started](docs/get-started.md): walks a first paper with Get started's checklist and its Show me ring.
- [Getting a manuscript ready to send](docs/submission.md): the TODOs panel, references and rename, Export for arXiv…, Export figures for a journal… and the submission checklist.
- [History](docs/history.md): keeps the project's history in its History tool panel, with versions, Compare… and the conflict resolver, and tracks the writer's changes for review (Track changes).
- [HTML files](docs/html-preview.md): shows an HTML file in Preview, Edit and Split.
- [Languages](docs/languages.md): speaks English and Simplified Chinese from the Tauri app's own catalog.
- [LuaLaTeX live preview](docs/live-preview.md): previews a LuaLaTeX project live with rtex.
- [Markdown files](docs/markdown.md): opens a Markdown file in Edit, Split and Preview, with the visual editor as an island.
- [Named workspaces](docs/workspaces.md): keeps named workspaces, shared by every project.
- [Notices](docs/notices.md): tells the writer what happened in the Tauri app's toast stack, with its pile, fan-out, clocks and swipe, and reminds about TeX package updates.
- [Overleaf](docs/overleaf.md): syncs a project with Overleaf: sign-in, Live and Manual modes, realtime editing, review, chat and Overleaf's history.
- [Papers](docs/papers.md): lists the bibliography's papers in the Papers panel, adds and checks references, and edits a `.bib` file in a visual form.
- [PDF preview](docs/pdf-preview.md): shows the PDF in the Tauri app's viewer on PDFium, images in its image preview, and jumps between source and PDF with SyncTeX.
- [Plugins](docs/plugins.md): runs the plugin host's commands from the palette, shows their items, diagnostics and messages, performs their actions, and installs and turns plugins on in Settings › Plugins.
- [Proofread, Polish and Rewrite](docs/proofread.md): asks the agent to proofread, polish or rewrite a selection, and reviews its edits in place.
- [Project tree](docs/project-tree.md): opens a project folder as the Tauri app does, in the Project tree with its file operations and Git status.
- [Saving and outside edits](docs/saving.md): saves as the Tauri app does, and takes outside edits into clean buffers and merges them into edited ones.
- [Settings](docs/settings.md): Settings (⌘,) as the Tauri app's, with the interface size, sounds and translucency.
- [Selection toolbar and highlights](docs/selection-toolbar.md): formats, links, headings and highlights a selection from the Tauri app's selection toolbar and highlighter palette.
- [Source editor](docs/editor.md): edits sources in Zed's editor with LaTeX, BibTeX and HTML highlighting, search, Vim, the editor adapter's cards, completion and diagnostics, the gutter, the outline rail and a `.tex` file's Visual view.
- [Terminal panel](docs/terminal.md): the Tauri app's Terminal panel, on Zed's alacritty-based terminal.
- [TeX doctor and setup](docs/tex-setup.md): the TeX doctor, the setup wizard and package installs.
- [Welcome screen](docs/welcome.md): opens without a project on the welcome screen, with New project and the guided tutorial.
- [Window's layout](docs/layout.md): lays the window out as the Tauri app does, on Trellis ported to GPUI.

A new feature adds its page and its line here, in alphabetical order, and a change to a feature edits its page.
What is not yet ported is [`docs/not-yet.md`](docs/not-yet.md), one line per item: a feature deletes its own line when it lands.

## License

This directory is GPL-3.0-or-later ([`LICENSE`](LICENSE)), because the app links Zed's GPL-3.0-or-later crates (editor, search, Vim, terminal, workspace).
`compat/` is Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)), and the upstream crates in `patches/` keep their Apache-2.0 license, with Lattice's diffs under it.
The interface sounds (`crates/lattice-gpui/src/sounds.rs`) port two of Cuelume's sound recipes and its audio graph, which are MIT ([`crates/lattice-gpui/LICENSE-CUELUME`](crates/lattice-gpui/LICENSE-CUELUME)).
`crates/trellis` is a port of Trellis by Dan Fessler ([github.com/DanFessler/trellis](https://github.com/DanFessler/trellis)), version 0.2.0, to Rust and GPUI, with the behaviour of Lattice's patch to it.
It is under the Trellis Public License v1.0 (Non-Commercial), not the GPL and not Apache-2.0; its license files are in [`crates/trellis/`](crates/trellis/README.md) ([`LICENSE.md`](crates/trellis/LICENSE.md), [`LICENSE-NONCOMMERCIAL.md`](crates/trellis/LICENSE-NONCOMMERCIAL.md), [`LICENSE-COMMERCIAL.md`](crates/trellis/LICENSE-COMMERCIAL.md)), and every ported file names the Trellis file it came from.
The window's panels are laid out with it, so the GPUI app as built includes Trellis code.

### Trellis and the GPUI app

- `crates/trellis`: Trellis Public License v1.0, Non-Commercial.
- The rest of the GPUI app: GPL-3.0-or-later.
- Lattice is free software, distributed without charge and for non-commercial use.
- Anyone who redistributes the GPUI app, or builds on `crates/trellis`, must also respect Trellis's non-commercial terms: keep its license files and the attribution "Uses Trellis by DanFessler - github.com/DanFessler/trellis", and use it commercially only under a Trellis commercial license from its author.
- GPL-3.0 forbids imposing further restrictions on a distributed work (sections 7 and 10), so Trellis's non-commercial terms conflict with it for a distributed GPUI binary that combines the two; the maintainer intends to ask Trellis's author for a GPL-compatible grant before any public release of the GPUI app.

These are the facts of how the code is licensed, not legal advice; the license texts themselves are what apply.

Lucide icons in `crates/lattice-ui/assets/icons/` (`download.svg`, `ellipsis.svg` and `file.svg`, which Zed's icon set shadows, and `tool-history.svg` from Lucide itself, as GPUI Kit's set lacks it) are copied unmodified, and `pin.svg` (a pinned tab's mark) is Lucide's pin with its stroke drawn in black as the app's own marks are; all keep Lucide's license ([`crates/lattice-ui/assets/LICENSE-LUCIDE`](crates/lattice-ui/assets/LICENSE-LUCIDE)).
The reading-aid faces in `crates/lattice-ui/assets/fonts/reading-aids/` (Atkinson Hyperlegible and OpenDyslexic, the Latin subset @fontsource publishes, unpacked from WOFF2 to TTF without other change) keep the SIL Open Font License 1.1 and their reserved names ([`LICENSE-atkinson-hyperlegible`](crates/lattice-ui/assets/fonts/reading-aids/LICENSE-atkinson-hyperlegible), [`LICENSE-opendyslexic`](crates/lattice-ui/assets/fonts/reading-aids/LICENSE-opendyslexic)).
Everything outside `gpui/`, the Tauri app and the backend crate the two apps share (`lattice-core`) included, stays Apache-2.0 ([`../LICENSE`](../LICENSE)); Apache-2.0 code can be part of this GPL work, not the other way round, so nothing under `gpui/` may be copied out of it into the Apache-2.0 tree.

## Running it

```sh
cd gpui
script/fetch-pdfium                      # PDFium chromium/8125, SHA-256 checked, into vendor/
cargo run --release -- path/to/project   # opens main.tex (or the .tex with \documentclass)
```

Requirements:

- Rust 1.99.1 (`rust-toolchain.toml`; Zed at the pinned revision asks for 1.98.1).
- A TeX distribution with `latexmk` (MacTeX, TeX Live, MiKTeX or TinyTeX); it is found the way Lattice finds it, so a GUI launch without `/Library/TeX/texbin` on `PATH` still works.
- Optionally TexLab (`brew install texlab`), found the same way, for the editor's diagnostics; without it the editor shows none.
- macOS: the Command Line Tools are enough, because GPUI compiles its Metal shaders at run time (`runtime_shaders`).
- Windows: MSVC, and `script/fetch-pdfium.ps1` for `pdfium.dll`. MiKTeX's `latexmk` needs Perl.

The first build fetches Zed at the pinned revision and compiles about 1,200 crates, with 3–5 GB of build output.

| Shortcut | Action |
|---|---|
| ⌘O / Ctrl+O | Open a project folder |
| ⌘S / Ctrl+S | Save edited files and build |
| ⌘⇧J / Ctrl+Shift+J | Mark the caret's line in the PDF (SyncTeX); a double-click in the PDF goes back |
| ⌘F / Ctrl+F | Find and replace in the current file (the Tauri app's find panel); in a focused PDF, Find in PDF |
| Enter / F3, ⇧Enter / ⇧F3 / ⌘⇧G | Next and previous match in the find panel |
| ⌘K or ⌘⇧P | Command palette: every command, the project's files, its Papers and every Settings row |
| ⌘P / Ctrl+P | Quick open: a file by name, `:42` a line, `@` a section or label |
| ⌘⇧F, ⌘⇧H | Find in project, Replace in project |
| ⌘⇧N | New project |
| ⌘⇧/ (⌘?) | Keyboard shortcuts |
| ⌘1 … ⌘9 | The workspace at that place |
| ⌘⌥1, ⌘⌥2, ⌘⌥3 | Show or hide Project, Papers, the Agent |
| ⌃` | Show or hide the Terminal (⌘` is the Mac's next-window key) |
| ⌘⇧↩ | Maximize the focused panel, or restore the layout |
| ⌘⇧D | Focus mode |
| ⌘⇧[ / ⌘⇧] | Previous or next tab |
| ⌘W, ⌘⇧T, ⌘⇧W | Close the document's tab (the window when none is open), reopen the last closed tab, close the window |
| ⌃Tab, ⌃⇧Tab | Next or previous project in the window |
| ⌘B, ⌘I, ⌘⇧M | In a LaTeX file, Bold (`\textbf`), Emphasis (`\emph`) and Inline math, each on or off for the selection |
| ⌘/, ⌘⌥/, ⌘⌥; | In a LaTeX file, comment the lines, or wrap them in a `comment` environment or `\iffalse … \fi` |
| ⌘⌥E, ⌘⌥I, ⌘⌥A, ⌃M | Wrap in `equation` or `itemize`, select the environment, go to the matching `\begin` or `\end` (else the matching math delimiter) |
| ⌘⌥S, ⌘⌥U, ⌘⌥L, ⌘⌥C | Sort lines, UPPER, lower and Title Case |
| ⌘⇧E, ⌘⌥R | Wrap in environment… (the name asked for), and Rename environment (both its `\begin` and its `\end`), in the Source and the Visual view |
| `$`, ↩ | In a LaTeX file, `$` pairs (and wraps a selection in `$…$`); ↩ after a `\begin{…}` writes its `\end{…}`, and on an `\item` line starts the next item or, on an empty one, leaves the list |
| ⌘⇧K, ⌘⇧L | In a LaTeX file, Insert citation and Insert reference: a picker of the bibliography's keys or the project's labels, writing `\cite{…}` or `\ref{…}` at the caret |
| ⌥⌘M | In a LaTeX file, the math symbol palette: search the maths commands by name, meaning or symbol and write one at the caret (in `$…$` outside maths) |
| ⌘G, ⌘⇧O | Go to line, and Go to symbol (the manuscript's sections and the project's labels) |
| ⌃L, ⌘I, ⌥⌘\\, ⌃⌥[ / ⌃⌥] | Select the line, the enclosing syntax (outside a LaTeX file), re-indent, fold or unfold everything, as CodeMirror binds them in the Tauri app |
| Vim `:w`, `:q`, `:wq`, `:N` | Save (and build), close the tab, both, go to line N |
| F12, ⌘-click | In a LaTeX file, Go to definition: a label's `\label`, a citation's entry, an `\input`'s file or a figure (TexLab for the rest, when installed) |
| Zed's default keymap | Everything else in the editor |

On Windows and Linux, Ctrl stands in for ⌘, and quitting is Alt+F4 or the menu. With Vim mode on there, Vim keeps Ctrl+O, Ctrl+B, Ctrl+I, Ctrl+G, Ctrl+S, Ctrl+K and Ctrl+W in the editor, in the Vim modes where its keymap binds them.
On every platform, Vim's normal and visual modes keep ⌃M as their next-line start, and with Vim on, `$` and ↩ follow the typing rules only in its insert mode.

"Vim mode" in an editor's ⋯ menu turns Zed's Vim mode on for every editor; `LATTICE_GPUI_VIM=1` turns it on for that run only, leaving the saved keymap as it is.

## Packaging

`node ../scripts/gpui-bundle.mjs` builds `Lattice Beta.app` (identifier `app.leo1oel.lattice-beta`, so it installs beside Lattice.app), or with `--flavor main` `Lattice.app` under the Tauri app's identifier (what release.yml ships to Apple silicon Macs from 0.19.0, [docs/updater.md](docs/updater.md)), into `target/bundle/`: the release binary without `offscreen-shots`, PDFium in `Contents/Frameworks`, and in `Contents/Resources` the island pages, the Synara and Open Slide runtimes staged as the Tauri build stages them (`SYNARA_SOURCE_DIR` names the pinned Synara checkout), the bundled skills and the icon.
It signs with the Developer ID in `APPLE_SIGNING_IDENTITY` (ad hoc without one), notarizes with the App Store Connect key release.yml uses when `APPLE_API_KEY`, `APPLE_API_ISSUER` and `APPLE_API_KEY_PATH` are set, and writes a `.dmg`, a `.zip` and the updater's archive, signed for the GPUI channel with `TAURI_SIGNING_PRIVATE_KEY` ([App updater](docs/updater.md)).
`../.github/workflows/gpui-package.yml` (Actions › GPUI package › Run workflow) does the same with the release secrets and keeps the files as the run's artifact; it publishes nothing.
It keeps its data in the GPUI app's own folders (`~/Library/Application Support/lattice-gpui`, `~/Library/Caches/lattice-gpui`), apart from Lattice.app's.
The Tauri app's local Beta flavor is named Lattice Tauri Beta (`../docs/release-process.md`), so the two install side by side.
Only Apple silicon macOS is packaged so far.

## CI

Pull requests do not run `.github/workflows/gpui.yml`; it runs for a release tag, weekly on main and by hand.
`pnpm signoff` (`../scripts/signoff.mjs`) checks a change locally when it touches `gpui/**`, `lattice-core` (`../src-tauri/lattice-core/**`, which the app builds on), one of the design-system exports `crates/lattice-ui` generates from (`../design-system/tokens.json`, `../design-system/code-themes.json` and what that is generated from), the scene staging the parity report uses (`../design-system/screens/`), or the Tauri code the island pages are built from (the editors in `../src/editor/spreadsheet/`, `../src/editor/board/` and `../src/editor/presentation/`, and the Agent page's `../src/agent/`, `../src/app/use-synara-host.ts`, `../src/settings/synara-settings-pane.tsx` and the other Tauri files it imports: `../src/trellis/trellis-agent-surface.tsx`, `../src/trellis/trellis.css`, `../src/app/git-workspace-frames.tsx`, `../src/app/git-repository-url.ts`, `../src/app/use-app-commands.ts`, `../src/app/key-combos.ts`, `../src/app/app-synara-embed.ts`, `../src/app/annotation-rounds.ts`, `../src/app/use-agent-spreadsheet-resolver.ts`, `../src/app/use-editor-comments.ts`, `../src/app/notify.ts`, `../src/hooks/use-latest-ref.ts`, `../src/app-types.ts`, `../src/components/icon-tip.tsx` and `../src/components/ui/motion` and `scroll-area` (`.tsx` and `.css`)): rustfmt, the release build with `offscreen-shots`, the unit tests, and the `e2e` scenario through `script/e2e`, which copies `fixtures/e2e` and runs the app with a scratch `HOME` and, as CI's macOS e2e step does, `GPUI_LAB_IGNORE_OCCLUSION` set, so a window the scenario opens is laid out on a locked or covered display, and with `GPUI_LAB_ASSUME_KEY` set, so runs side by side queue for the machine-wide input lock only for the steps that need the real key window (`crates/lattice-gpui/src/scenario/input_lock.rs`).
Its release build and unit tests run through `../scripts/gpui-build.mjs`, in one build tree the machine shares: it mirrors the checkout there, builds under a machine-wide lock (a second worktree's build waits for it), and copies `target/release/lattice-gpui` back.
Every worktree builds from the same paths there, so only what changed since the last build compiles; a plain `cargo build --release` in a new worktree starts cold, since sccache keys Rust compiles on the checkout's paths.
In a no-mistakes run worktree plain cargo that compiles is refused outright: the pipeline's prepare step installs `../scripts/run-worktree-cargo-guard.mjs` in the run worktree and in the directory holding every run worktree (so the next run is guarded before its review step compiles), which fails such a command within a second and prints the same command through `../scripts/gpui-build.mjs` ([`docs/agent-validation.md`](../docs/agent-validation.md)).
Elsewhere, `target/` stays per checkout on purpose: Cargo judges freshness by mtime, so checkouts sharing one `CARGO_TARGET_DIR` can reuse each other's artifacts for files that differ, and the shared tree's mirror is what makes sharing safe.
Its `code-themes` job fails while `code-themes.json` is stale (`node design-system/code-themes.mjs --check`), and its `patches` job while `patches/` is not upstream plus its diffs (`script/check-patches`). A separate workflow, `.github/workflows/gpui-patches.yml`, run by hand for a change to `patches/`, it applies the diffs to gpui-fast at the pin and runs the tests they add (element scale, letter spacing).
On macOS and Windows it builds the app (release profile), runs the unit tests and the `e2e` scenario on `fixtures/e2e`; on macOS it then writes the parity report (below), which does not fail the job and is skipped for a release tag. `lattice-core`'s own tests run with the Tauri app's (`ci.yml`).
macOS builds with TeX Live and TexLab (so the e2e scenario checks TexLab's diagnostics); Windows builds with MiKTeX and no TexLab, where that step reports itself skipped.
The macOS e2e step, like `script/e2e`, sets `GPUI_LAB_IGNORE_OCCLUSION`, so the window keeps drawing the editor's carets, gutter marks and cards even when the runner's display stops compositing it.
The Chinese input method (Microsoft Pinyin on Windows) and MiKTeX's own package-install prompts are checked by hand; CI cannot drive them.

## How it is put together

```
crates/lattice-gpui   the app: shell (titlebar, the Trellis workspace and its
                      skin, layouts, workspaces and presets, command table,
                      palette, menu bar, windows and project tabs:
                      src/shell/), project, file tree, quick open and find /
                      replace in project (src/search/), the welcome screen
                      and project dialogs (src/welcome/), recent projects,
                      editor panel, PDF panel (PDFium on its own thread), build
                      panel, the Terminal panel (src/terminal/), notices
                      and confirmations, scripted scenarios
                      (macOS, Windows)
crates/trellis        Trellis 0.2.0 ported to GPUI with Lattice's patch (the
                      layout model, the engine, the view drawn through a
                      skin); under Trellis's non-commercial license
crates/lattice-editor the adapter over Zed's editor every editor feature
                      decorates through (marks, highlights, gutter marks, block
                      widgets, hover cards, completion sources, remote carets),
                      the LaTeX language and the LaTeX extensions on it, the
                      project's citation and label index, TexLab
crates/lattice-i18n   English and Simplified Chinese: the Tauri app's Lingui
                      catalog read at build time, a catalog of the GPUI app's
                      own strings, `t!`, and the coverage check
crates/lattice-settings
                      the Tauri app's preferences typed, the settings file,
                      and the import from the Tauri app's WebKit storage
crates/lattice-webview
                      webview islands: the host (lazy load, hibernation, reveal,
                      theme, focus and shortcut forwarding, overlays and panel
                      drags), the page bridge, the local asset protocol and the
                      file bridge
islands/              the board, spreadsheet, Open Slide, Markdown and Agent
                      pages and the editor cards' math page, built from ../src
                      by script/build-islands into islands/dist
crates/lattice-ui     Lattice's look: design tokens generated from
                      ../design-system/tokens.json, the palette, GPUI Kit and
                      Zed editor themes, fonts, type roles, motion, elevation,
                      icons, components, and the tab-strip constants and
                      helpers Lattice's Trellis skin (shell/skin.rs) uses;
                      its GPUI Kit dock renderer is unused, kept until a
                      follow-up prunes it
../src-tauri/lattice-core
                      the backend the Tauri app runs on (a path dependency):
                      projects, the tree and its file operations, builds,
                      SyncTeX, saving with merge, the project watcher
compat/               shims that leave one GPUI (gpui-pre, gpui-fast) and one
                      SQLite (sqlite) in the graph
patches/              upstream crates with Lattice's diffs: gpui-fast's GPUI and
                      macOS platform, GPUI Kit's components, foundation and
                      webview (patches/README.md)
fixtures/e2e          the project the e2e scenario runs on (copy it first)
```

### lattice-core

The app depends on `../src-tauri/lattice-core` by path, the crate the Tauri app's commands call, so both apps run one backend: opening a project (and adopting a folder Lattice did not create, with its `.research/` folder), the Project tree's scan and file operations, the build, SyncTeX, the editor save that merges an outside edit, and the project watcher.
Its dependencies resolve in this workspace's `Cargo.lock`, at the Tauri app's versions where it pins them.
`lattice-core`'s version follows the app's; `../scripts/bump-version.mjs` rewrites its entry in this lockfile too, so `cargo build --locked` keeps passing after a release.
Zed's `sqlez` and `lattice-core`'s `rusqlite` link different `libsqlite3-sys` versions, which Cargo refuses in one graph; `compat/sqlite` gives 0.38 the version 0.30 (its README).

### One GPUI for Zed's editor and GPUI Kit

The app runs on gpui-fast (longbridge/gpui-fast), a fork of Zed's GPUI with retained-mode rendering, cached scroll layers and window composition (native views between GPUI's content and its overlays).
gpui-fast `bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa` tracks Zed commit `d2a4fb6ded7c470be25d1541281da3882495b65b` (its `UPSTREAM` file), the commit the workspace pins Zed's crates (the editor, search, Vim, terminal, settings, themes) at, and keeps Zed's crate names, so the `[patch."https://github.com/zed-industries/zed"]` table swaps Zed's GPUI family for gpui-fast's. `util` stays Zed's: gpui-fast's copy has its own `rel_path` types, which Zed's crates reject.

GPUI Kit 0.9.1 and gpui-webview 0.9.1 run on gpui-fast through their `gpui-fast` feature (gpui-webview checks that the two agree). That feature asks for the crates.io `gpui-fast*` 0.1.14 packages, and GPUI Kit still names the `gpui-pre` 0.3.12 snapshot besides, so Cargo would build three GPUIs; the shims in `compat/` carry those names and versions and re-export the workspace's GPUI, and `[patch.crates-io]` swaps them in.
`Cargo.lock` was seeded from Zed's own lockfile at that commit, and Zed's `[patch.crates-io]` entries are repeated in the workspace manifest because a dependency's patches do not apply.

GPUI itself, gpui-fast's macOS platform and GPUI Kit's components, foundation and webview are the copies in `patches/`, upstream at those pins plus Lattice's diffs, each listed with its reason in `patches/README.md`, which also has the provenance. `script/check-patches` rebuilds them from upstream and fails on any difference.

### Lattice's look

The app draws what the Tauri app draws: the parity target is the running app as Paper's App screens page records it, with `design-system/tokens.json` (exported from Paper) as the source of every value.

- `crates/lattice-ui/src/tokens/` is generated from the JSON, and from `design-system/code-themes.json` for the code themes; a test fails while they disagree. After a Paper export, or after `node design-system/code-themes.mjs` re-exports the Tauri app's code themes, regenerate with `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
- `Palette` resolves every colour role for an appearance, tint and accent preset the way `src/styles/theme.css` derives them; GPUI Kit and Zed's editor are themed from it (`kit.rs`, `editor_theme/`, one Zed theme per Lattice code theme), so their own components start in Lattice's colours.
- The panels are Trellis's, ported (`crates/trellis`), and wear Lattice's skin (`shell/skin.rs`, from `src/trellis/trellis.css`): rounded cards whose surface follows the selected view, 40px strips of pill tabs, the divider's grip in the accent after a hover delay, Trellis's drop slot with "Add as tab". A strip short of room gives way as Lattice's Trellis patch plans it (`planHeader`), from the tabs' shaped widths.
- Fonts: Inter, Ioskeley Mono and Instrument Serif are bundled (`script/make-fonts` writes them, Inter's Italic and Medium Italic as its Regular and Medium slanted 14°, the oblique WebKit synthesizes for a preview tab's title), with the reading aids Atkinson Hyperlegible and OpenDyslexic. The private Timeless faces are embedded at build time by `crates/lattice-ui/build.rs` when `LATTICE_PRIVATE_FONTS_DIR` (default `~/Downloads/Timeless-Type-Family-1.094`, empty for none) holds the complete download, as the Tauri build embeds them; `LATTICE_PRIVATE_FONTS_REQUIRED=1` fails the build without them. The download's `LICENSE.pdf` is embedded, unmodified, with them (`lattice_ui::fonts::font_license()`); a download without it counts as incomplete, so the faces are not embedded. The app never reads them at run time, and they are never committed.
- `LATTICE_APPEARANCE=light|dark` fixes the appearance instead of following the system's.
- Hover, motion, reveal, scrollbars and nested corners are Fluid Functionalism's, as the Tauri app has them: one gliding fill per list (`fluid_hover`), the motion tiers and `Tween` (`motion`), a sliding selection plate (`sliding`), `reveal`, Lattice's scrollbar (`scrollbar`) and `shape::Nest`.
  [`docs/design-system.md`](docs/design-system.md) is their API; use them rather than a per-row hover, a hand-written duration or a restated radius.
- Components (`lattice-ui/src/components/`) follow Paper's Components boards; hover and press fade on the motion tiers (`interaction.rs`). Menus, selects and popovers spring from their trigger from 95%, tooltips grow from 98%, dialogs and sheets rise from 98%, and toasts drop in from 96%, each on its tier as the Tauri app's CSS has it (`motion::Entrance`, drawn with GPUI's element scale). Type roles set normal tracking, and an uppercase micro label opens it to the caps tracking (`Tracking::Caps`). `lattice-gpui --gallery` draws them all on one sheet (`LATTICE_GALLERY_PAGE=2` for the overlays and surfaces) and, with `LATTICE_SHOT_OUT` and `--features offscreen-shots`, saves it.

### Settings and languages

The settings are the Tauri app's (`src/settings/app-settings.ts`), field for field and read the same way (`crates/lattice-settings`): each field is read on its own, and one that is missing or unusable takes its default. They live in `settings.json` in the state directory (`LATTICE_GPUI_STATE_DIR` moves it; a scripted run keeps them in memory), written whole on every change and checked every second, so an edit made outside the app applies (one that does not parse, or is from a newer version, is left as it is and the settings in use stay; at startup, or when a choice is next saved over it, such a file is moved aside to `settings.json.unreadable`, or `.unreadable.2` and so on when that name is taken, and at startup the defaults apply). When there is no file, the first run reads the Tauri app's choices from its WebKit storage (`~/Library/WebKit/app.leo1oel.researchwriter/WebsiteData`, a copy of each LocalStorage database, never the database itself; `LATTICE_GPUI_TAURI_STORAGE` names another directory, empty for none) and writes them as the file.

Every string the app shows goes through `lattice-i18n`'s `t!`, keyed by its English as Lingui keys it, so the Chinese is the Tauri app's own (`../src/locales/zh-CN/messages.po`, read at build time) wherever the two apps share a string; what only the GPUI app says is in `crates/lattice-i18n/locales/zh-CN/`, one file per area of the app with its entries sorted by source string (a feature adds its strings in their places, or a file of its own). `cargo test -p lattice-i18n` fails while a string the app translates has no Chinese, the port of `scripts/check-i18n-coverage.mjs`. The interface follows the system's first preferred language unless Settings fixes one; a scripted run is in English unless its settings say otherwise.

### Webview islands

The surfaces that stay web content (the Agent, boards, sheets, slide decks, the visual Markdown editor, the HTML preview) were iframes of the Tauri app; here each is an island, `lattice_webview::Island`, in its panel: a WKWebView (WebView2, WebKitGTK) that gpui-webview places between GPUI's base content and its overlay surface, so menus, popovers, tooltips, the palette, dialogs and toasts, all drawn deferred, stay above the page.
The HTML preview is the first (`src/html_preview.rs`, its page in `assets/islands/html-preview/`); the host gives every island the rest:

- Lifecycle: nothing is built until the island is first shown; hidden for 20 s (the Tauri app's `HIBERNATE_AFTER_MS`) it is torn down and built again when shown, the owner restoring the page's state when it reports ready; what is posted before then waits, the latest of each event only. An island whose config says it does not hibernate (the Agent's, `IslandConfig::hibernates`) keeps its page while hidden. The owner says when it is shown, since a native view does not hide by not being painted; an island also hides itself while it is missing from the window's last frame (another panel maximized over it), checked after every layout change and every 250 ms while shown.
- Reveal: until the owner says the page has drawn, it is laid out at its size but clipped away, so the GPUI placeholder (the HTML page skeleton) shows and the first visible frame is a loaded one.
- The bridge (`assets/bridge.js`, injected into the main frame): events and requests both ways, the page's focus and presses, the theme as the Tauri app's CSS variables, and the app's shortcuts typed in the page. Only the island's own page may speak: each webview gets a random token that only its main frame's bootstrap holds and sends with every message, and a message without it, or from a frame not served by the island protocol, is dropped, as is a shortcut the host did not relay to the page. No frame navigates anywhere but the island's bundle, and a project file is served with `Content-Security-Policy: sandbox`, so an authored page cannot load one as a document of the island's.
- The local asset protocol: a page and its scripts are served under `lattice://island/bundle/…` (`http://lattice.island/…` on Windows), compiled into the binary (the HTML preview's) or from a built directory on disk (the pages below), and a project file only once the host grants it, at `…/asset/<path>`; nothing outside the bundle's directory or the project, through `..`, an absolute path or a symlink, whatever was granted. The file bridge reads the granted files by the same rule (`files:read-text`). No island writes through the bridge: a board's or sheet's text is its panel's, saved through lattice-core's editor transaction like any document, and a deck's saves are mutations its owner applies through lattice-core, refused outside what Open Slide mirrors (`slides/`, `assets/`, `themes/`, `open-slide.config.ts`).
- Theme: a page written for the GPUI app gets the palette as the Tauri app's CSS variables; a page built from the Tauri app's modules gets the root attributes the app sets (`data-theme`, `data-tint`, `data-accent`, and a custom accent's `--accent`), so its own stylesheets resolve every token as they do there (`IslandTheme`).
- Frames from elsewhere: only an origin the owner allows (`Island::allow_frame_origin`) may load in a page's frames.
- Focus: a click in the page moves GPUI's focus to the island (AppKit's first responder decides whether the page has the keyboard), so the key context is the island's; the page then hands back only the app's own shortcuts it did not handle itself (from the keymap, evaluated in that context, never the editing keys and never while an input method composes; a key the page took, Markdown's ⌘B or a board's ⌘], stays the page's, as in the Tauri app) and the host dispatches them after the current update, with AppKit's first responder back in GPUI's view when the keys moved GPUI's focus elsewhere (the Phase 0 spike's fix).
- Overlays: anything drawn over a page must be deferred, and must not cover the page with a hitbox, since the overlay surface takes every point one of its hitboxes covers; GPUI's presses outside the page reach it as `host:outside-pointerdown`. While a panel is dragged every island steps aside, so the drop targets under it work. The Trellis workspace's floating panels (and, above them, its drop slot and a dragged panel) are drawn deferred too, so one floating over a docked island is above the page; an island floating in a panel is hosted on the overlay surface itself, so a menu or toast that overlaps it is under its page.
  On Windows, gpui-webview 0.9.1 does not compose WebView2 yet, so a GPUI overlay over a page (the preview's zoom controls, a menu, a toast) is under it until the plan's snapshot-and-hide is in; the island checks run on macOS.

### Boards, spreadsheets and decks

`islands/` is a small Vite package (`islands/vite.config.ts`) that builds the island pages from the Tauri app's modules in `../src` with the app's own toolchain (React Compiler, Lingui, Tailwind, the private faces): the board (`src/editor/board/board-editor.tsx`), the spreadsheet (`src/editor/spreadsheet/spreadsheet-editor.tsx`) and the Open Slide workspace (`src/editor/presentation/open-slide-workspace.tsx`), each as it is, beside the visual Markdown editor's and the Agent's (above) and a `.tex` file's Visual view (`islands/latex/`, [Source editor](docs/editor.md)).
The math page (`islands/math/`) is never shown: the source editor's cards load it into a WKWebView no window holds and draw WebKit's snapshot of each equation KaTeX sets there (`crates/lattice-gpui/src/card_previews/math_page.rs`).
`script/build-islands` (from the root's `node_modules`) writes them to `islands/dist`, which the app finds beside the checkout it runs from, in `Contents/Resources/islands`, or at `LATTICE_GPUI_ISLANDS_DIR` (`structured/resources.rs`); `script/e2e` and CI build them first.
A page loads the app's stylesheets and faces, and stands in for Tauri's internals (`islands/shared/tauri-internals.ts`), so every `invoke` the modules make is a request to its owner over the bridge, which answers the few each kind needs (`save_xlsx` and the save panel for a sheet; the Open Slide lease, refresh and reads for a deck) and refuses the rest. The app's toasts and confirmations the modules raise are GPUI's, above the page.
The owner (`src/structured.rs`, with `editor_panel/structured_view.rs`) puts the page in place of the editor: the page's serialized text (`doc:change`) becomes the buffer's, a reload from disk goes to the page (`doc:source`), view state (a board's camera, a sheet's scroll and zoom, a deck's page) stays out of the file for the session, and a hidden page or a closing tab has the page hand over what its debounce holds before the save (`doc:flush`, `doc:flushed`).
A deck's runtime is lattice-core's supervisor, one per process (`structured/presentation.rs`); each deck's page is a lease owner of its own, so a hibernated or closed page's leases are dropped as a closed Tauri page's are.

### The editor adapter

`crates/lattice-editor` puts one Lattice-shaped API over Zed's editor, the way the Tauri app builds its source editor out of CodeMirror extensions (`../src/editor/`). `LatticeEditor` wraps Zed's `Editor` over a buffer, and a feature says what to show in buffer offsets, in named layers that it replaces whole:

- marks (an underline, wavy or straight, the ink, a strike, the weight) and highlights (a wash behind the text): Zed's text and background highlights, anchored so they follow later edits; Zed keys them by a closed enum, so each layer's styles take slots of a key nothing else in the app sets;
- the source gutter (`adapter/gutter_column.rs`), in place of Zed's, which sizes itself in whole character widths: line numbers and fold markers laid out as CodeMirror's (`src/editor/source-gutter.ts`), with the editor element inset by it and by the room the host keeps at the right (the outline rail's), so the text and its wrap match CodeMirror's; a language gives it what each line folds (`folds::FoldSource`; LaTeX's is `latex/folding.rs`, the Tauri app's text scan), and the overlay scrollbar is lattice-ui's shared one in the editor's feel;
- gutter marks, painted by the adapter's overlay with an optional hover card: a dot beside a line, over the gutter's free left edge (the end-to-end scenario proves it with a layer of its own), or a numbered pin over the fold column, the annotations' ([Annotations](docs/annotations.md));
- block widgets: Zed's blocks, between lines;
- hover cards: Zed's editor hovers only for language servers, so the overlay runs the pointer itself: each provider names its range and builds its card, and every provider's card at the pointer (over one of the range's characters, on any row soft wrap puts it, never past a line's end) opens after it rests 300 ms (CodeMirror's `hoverTime`), stacked in provider order as CodeMirror's hover host stacks its sources' tooltips (a citation card over the lint card of a diagnostic on the same key).
  The stack rises above its ranges on the pop tier (below them when the editor has no room above) and stays inside the editor.
  While the pointer stays by the stack, it follows the ranges under the pointer: a card whose range the pointer comes onto joins after the hover delay with its own entrance, and one whose range it leaves goes after a 150 ms grace; on ranges none of which has a card shown, the stack closes at once and their cards open after the hover delay.
  The stack closes when the pointer leaves the ranges and the cards, on a key or an edit;
- completion sources, given to Zed's completion menu through one provider; each source filters and orders its own options, as the Tauri app's citation source must, and a pick can put the caret inside the inserted template and open the menu again (a `\cite{}` lists the keys next);
- inline texts: text shown at a point that is not in the buffer, as CodeMirror's inline widgets (Overleaf's suggested deletions and an accepted proofread's old words, struck through; a highlight's colour swatch before its `\colorbox`): Zed's inlays, with each one's look (`InlineLook`: a strike and tint, or a swatch in two spaces' room) painted over it by the overlay, since Zed styles all inlays alike, and kept without a re-splice when only the looks change;