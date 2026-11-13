# Lattice on GPUI (preview)

A native GPUI version of Lattice's LaTeX writing flow, growing beside the Tauri app in this repository.
The Tauri app in `../src` and `../src-tauri` keeps shipping; nothing here is built, tested or released with it, and `gpui/` is its own Cargo workspace.

Its backend is the Tauri app's own: `lattice-core` (`../src-tauri/lattice-core`), the crate both apps share. What it does so far, and nothing more:

1. Opens a project folder as the Tauri app does (a folder Lattice did not create is adopted the same way), with the Project tree on the left: the same files shown and hidden, a chain of single folders flattened into one row, New file, New folder, Import files…, Rename, a dragged row moved into a folder, ⌘C / ⌘V duplicating a row, Delete, Set as main document, Show hidden files, and each changed file's Git status (its colour and letter, a dot on the folders above it).
2. Edits sources in Zed's editor with LaTeX highlighting in Lattice's code themes, search (Zed's buffer search bar) and an optional Vim mode (Zed's Vim); in a `.tex` file, a card for the citation key or `\ref` label under the pointer, completion of commands, citation keys and labels, and TexLab's diagnostics (when `texlab` is installed), through Lattice's editor adapter (below).
   The source gutter is the Tauri app's: four-digit line numbers and a fold column whose chevrons show over the gutter and fold a LaTeX environment, section, preamble, brace group or comment block, so the text starts where CodeMirror's does.
   A `.tex` file has the outline rail on the editor's right edge (its sections' marks, the one being read in the accent; resting on it opens the outline with numbers and PDF pages, and a row jumps there), and the Source / Visual switch in its strip, where Visual says it is not in the GPUI preview yet.
3. Saves as the Tauri app does: after a pause in typing, on leaving the editor, and before a tab or window closes, another project opens in its window or the app quits, merging an edit made outside Lattice since the file was loaded rather than writing over it; an outside edit reloads a clean buffer, and a file moved or deleted outside Lattice is followed, closed or held with its edits.
4. Shows the PDF on the right, rendered natively by PDFium, in the Tauri app's viewer: page navigation and a typed page, Back and Forward over link jumps, the outline, Find in PDF (Match case, Whole word, the match counter), zoom steps, a typed zoom, ⌘-wheel / Ctrl-wheel and pinch around the pointer, Fit width and Fit height, dark pages and Save PDF as…; a toolbar 640px or narrower folds the secondary controls into a ⋯ menu, as the Tauri app's does. A drag selects text and ⌘C / Ctrl+C copies it; a link jumps (Back returns) or opens in the browser. A rebuild redraws only the pages it changed. The live PDF can move into a window of its own, which opens again, behind the workspace, when the project opens next; each other root document built keeps its last PDF in a tab of its own; a PDF of the project opens from the tree in a tab among the documents.
   It jumps between the PDF and the source with SyncTeX: ⌘⇧J / Ctrl+Shift+J (or the PDF toolbar's locate button) marks the caret's line in the PDF, a double-click in the PDF opens its source line, and an Outline row opens its heading and marks it in the PDF; the Outline marks the section the caret of the editor in front is in.
5. Builds with lattice-core's latexmk build on one click (or ⌘B / Ctrl+B; ⇧-click rebuilds clean), and after each save and each outside edit it loads (the Tauri app's default automatic builds), and reloads the PDF in place. The Build button's hover card lists the passes latexmk ran; a build can be stopped, and the build files cleaned. The build's diagnostics are the Tauri app's card over the PDF (or docked under it): TeX's messages in plain words with the failing line quoted, a typo's one-click fix, a missing package's install, and errors that jump to their line (F8 / ⇧F8 step through them).
6. The TeX doctor (Settings › TeX doctor, and in a sheet of its own from the palette), the setup wizard that installs BasicTeX (TeX Live on Windows) when a build finds no TeX, and the status bar's word counts (the manuscript's through TeXcount, this file's, the selection's) and its Annotations and TODOs counters (the open buffer's TODOs rescanned once typing pauses).
7. Lays the window out as the Tauri app does, with Trellis itself ported to GPUI (`crates/trellis`): Project and the Agent over Papers on the left, the documents between, the PDF on the right, each a rounded card with a 40px strip of tabs. Tabs drag between panels with Trellis's drop slot (an edge splits, the middle adds a tab), a panel's last tab takes the panel with it and its neighbours take its room, dividers resize with Trellis's rubber band and spring, panels float, maximize, hide and close from their ⋯ menu or keys, and a narrow strip gives way as Lattice's patch plans it. Free navigation (pinch and ⌃-wheel zoom, ⇧-drag marquee) frames any part of the layout. Workspaces, the Writing and Reading presets, focus mode and each project's layout run on Lattice's own layout functions (`shell/trellis_layout`, ported from `src/trellis/trellis-layout.ts`).
8. Keeps named workspaces, shared by every project (a dot while the project's layout differs; "+", rename in place, save, revert, duplicate, move, delete with undo), the Writing and Reading presets and focus mode over them, and each project's own layout, restored when it opens again.
9. Reaches every command from the command palette (⌘K), the keymap, the shortcut sheet (⌘?) and the menu bar; opens projects in new windows or as tabs in one, from the title bar's project menu (the recent projects, each in a window of its own or in this one), File ▸ Open Recent or the palette.
10. Finds things in the project as the Tauri app does: quick open (⌘P) lists the files visited this session first and ranks a typed name, `:42` goes to a line of the file on screen and `@` to a section or label; Find in project (⌘⇧F) searches the project's files and its papers library, the hits gathered under each file, F3 stepping through them; ⌘[ and ⌘] go back and forward over the places visited; Replace in project (⌘⇧H) previews every match, then rewrites them through lattice-core, which records the replacement in the project's history.
11. Opens without a project on the welcome screen (the lattice field, the mark weaving in, New project, Open folder, Clone repository, the guided tutorial, the three recent projects on ⌘1 to ⌘3 laid on the desk with each one's first page and venue, Import ZIP, Install LaTeX tools), and reopens the project used last at launch, saying so there when its folder has gone. New project (⌘⇧N) creates one from any of the Tauri app's venue templates.
12. Settings (⌘,): Appearance (interface language, the interface size, notification position, interface sounds, both editors' type, the theme's appearance, tint, accent and code theme, translucency, the title bar's tools) and Editor & builds (keymap, spell checking, your name, the project dictionary, the automatic build, cleaning, the project's engine, shell escape and halt on error), searchable, applied as each choice is made, kept in `settings.json` and watched; the first run imports the Tauri app's own choices.
    The interface size zooms every window as the Tauri app's webview zoom does (90% to 135%), from Settings, ⌘+ / ⌘= and ⌘− (with the size pill under the titlebar) and ⌘0, View ▸ Actual Size, Bigger and Smaller, and the palette.
    Interface sounds are the Tauri app's two cues, synthesized from the same Cuelume recipes, for a build the writer asked for and a running notice that settles.
    Spell checking marks Harper's spelling and grammar findings in `.tex`, `.md` and `.txt` files (a LaTeX document in another language against its Hunspell dictionary, downloaded on first need) with the lint card's fixes, Add to project dictionary and the project's ignores.
    Translucency puts macOS's under-window vibrancy behind a frosted titlebar, gutters, Project and Papers, as the Tauri app does (off while Reduce transparency is on).
13. Speaks English and Simplified Chinese, from the Tauri app's own catalog (`crates/lattice-i18n`), menus included.
14. Shows an HTML file as the Tauri app does, in Preview until another view is chosen (Edit, Split and Preview in its strip and its ⋯ menu, each file keeping its own): the Tauri app's sandboxed preview (its images and embedded pages loaded, relative links disabled, web links to the browser) in a webview island, following the editor 180 ms after typing pauses, with its zoom (50% to 200%, or typed) and Lattice's scrollbar drawn over the page, and its reading position and zoom kept across edits and views. The islands are below.
15. Lists the papers the project's bibliography cites in the Papers panel, as the Tauri app does: one box that searches the library by its metadata at once and by the papers' saved text (their matching lines under each paper, each opening it at that line), and adds an arXiv id, DOI, URL or BibTeX entry it does not hold (a known one says where it already is); a count of what is shown, filters (cited here, not cited yet, with full text, flagged), sorts and groups (year, venue, reading state); each paper's glyph, title, how often the manuscript cites it, byline, citation-health notice, and under the pointer its citation key to copy, its link and Remove (which asks first, and what to do with its citations); a click opens a saved paper's text or downloads it (the box showing the stage, with Cancel). A maximised panel lays the papers out as a table and shows the selected paper in an inspector: its uses in the manuscript, abstract and record.
16. Adds papers in bulk (Add papers: pasted ids, DOIs, URLs, titles or BibTeX, each looked up and added or reported; a reference entered by hand; or papers ticked in the Zotero library's folders, each bringing its PDF and its annotations, which go to the paper's note; or a linked library, a reference manager's .bib whose new papers, updates, changes made here too and dropped papers are laid out to tick before any reach the project's .bib), discovers literature in a drawer searching OpenAlex and alphaXiv (a result added to Papers or cited through Add papers), checks the bibliography's references against their published records (Check references: findings grouped To fix, To review, Incomplete, Not checked, Kept and Verified, applied one by one or all at once, the report kept between runs), reads a saved paper in its own tab (its Blog or Paper rendered, with its source and original PDF a click away), and shows a `.bib` file as Edit, Split or Preview: its references as a searchable list (filtered by use, sorted by file order, year, author or title) beside the reference in front as a form whose every field edits the file in place, undoable from the source's history, with Add reference looking a citation up or taking it by hand.
17. The Bibliography layout preset: the Papers library beside the bibliography, the `.bib` in front.

Not yet: the visual LaTeX and Markdown editors, Overleaf, the Agent (its panel holds its place with a note), canvas, spreadsheet, slides, live preview, the import conflict dialog's Replace and Skip (an import keeps both), pasting a clipboard image into the tree as a figure; in the PDF its annotations, comment column, review export and citation hover cards; and of Settings, the grammar page (its dialect, profile and rules; spell checking uses the Tauri app's defaults) and the agent, integration and about pages.

## License

This directory is GPL-3.0-or-later ([`LICENSE`](LICENSE)), because the app links Zed's GPL-3.0-or-later crates (editor, search, Vim, workspace).
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

Lucide icons whose names Zed's icon set shadows, such as `crates/lattice-ui/assets/icons/download.svg`, `ellipsis.svg` and `file.svg`, are copied unmodified from GPUI Kit's assets and keep Lucide's license ([`crates/lattice-ui/assets/LICENSE-LUCIDE`](crates/lattice-ui/assets/LICENSE-LUCIDE)).
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
| ⌘B / Ctrl+B | Save edited files and build |
| ⌘S / Ctrl+S | Save edited files and build |
| ⌘⇧J / Ctrl+Shift+J | Mark the caret's line in the PDF (SyncTeX); a double-click in the PDF goes back |
| ⌘F / Ctrl+F | Find in the current file (Zed's search bar: regex, case, whole word, replace); in a focused PDF, Find in PDF |
| ⌘K or ⌘⇧P | Command palette: every command, and the project's files |
| ⌘P / Ctrl+P | Quick open: a file by name, `:42` a line, `@` a section or label |
| ⌘⇧F, ⌘⇧H | Find in project, Replace in project |
| ⌘⇧N | New project |
| ⌘⇧/ (⌘?) | Keyboard shortcuts |
| ⌘1 … ⌘9 | The workspace at that place |
| ⌘⌥1, ⌘⌥2, ⌘⌥3 | Show or hide Project, Papers, the Agent |
| ⌘⇧↩ | Maximize the focused panel, or restore the layout |
| ⌘⇧D | Focus mode |
| ⌘⇧[ / ⌘⇧] | Previous or next tab |
| ⌘W, ⌘⇧T, ⌘⇧W | Close the document's tab (the window when none is open), reopen the last closed tab, close the window |
| ⌃Tab, ⌃⇧Tab | Next or previous project in the window |
| Zed's default keymap | Everything else in the editor |

On Windows and Linux, Ctrl stands in for ⌘, and quitting is Alt+F4 or the menu. With Vim mode on there, Vim keeps Ctrl+O, Ctrl+B, Ctrl+S, Ctrl+K and Ctrl+W in the editor, in the Vim modes where its keymap binds them.

"Vim mode" in an editor's ⋯ menu turns Zed's Vim mode on for every editor; `LATTICE_GPUI_VIM=1` turns it on for that run only, leaving the saved keymap as it is.

## CI

Pull requests do not run `.github/workflows/gpui.yml`; it runs for a release tag, weekly on main and by hand.
`pnpm signoff` (`../scripts/signoff.mjs`) checks a change locally when it touches `gpui/**`, `lattice-core` (`../src-tauri/lattice-core/**`, which the app builds on), one of the design-system exports `crates/lattice-ui` generates from (`../design-system/tokens.json`, `../design-system/code-themes.json` and what that is generated from), or the scene staging the parity report uses (`../design-system/screens/`): rustfmt, the release build with `offscreen-shots`, the unit tests, and the `e2e` scenario through `script/e2e`, which copies `fixtures/e2e` and runs the app with a scratch `HOME` and, as CI's macOS e2e step does, `GPUI_LAB_IGNORE_OCCLUSION` set, so a window the scenario opens is laid out on a locked or covered display.
Its release build and unit tests run through `../scripts/gpui-build.mjs`, in one build tree the machine shares: it mirrors the checkout there, builds under a machine-wide lock (a second worktree's build waits for it), and copies `target/release/lattice-gpui` back.
Every worktree builds from the same paths there, so only what changed since the last build compiles; a plain `cargo build --release` in a new worktree starts cold, since sccache keys Rust compiles on the checkout's paths.
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
                      panel, notices and confirmations, scripted scenarios
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
Its dependencies resolve in this workspace's `Cargo.lock`, at the Tauri app's versions where it pins them (`harper-core` and its family are held at the Tauri app's 2.7.0).
`lattice-core`'s version follows the app's; `../scripts/bump-version.mjs` rewrites its entry in this lockfile too, so `cargo build --locked` keeps passing after a release.
Zed's `sqlez` and `lattice-core`'s `rusqlite` link different `libsqlite3-sys` versions, which Cargo refuses in one graph; `compat/sqlite` gives 0.38 the version 0.30 (its README).

### One GPUI for Zed's editor and GPUI Kit

The app runs on gpui-fast (longbridge/gpui-fast), a fork of Zed's GPUI with retained-mode rendering, cached scroll layers and window composition (native views between GPUI's content and its overlays).
gpui-fast `bbf6dead71bb5dbfd3c3592f7a3d0137d5cf81aa` tracks Zed commit `d2a4fb6ded7c470be25d1541281da3882495b65b` (its `UPSTREAM` file), the commit the workspace pins Zed's crates (the editor, search, Vim, settings, themes) at, and keeps Zed's crate names, so the `[patch."https://github.com/zed-industries/zed"]` table swaps Zed's GPUI family for gpui-fast's. `util` stays Zed's: gpui-fast's copy has its own `rel_path` types, which Zed's crates reject.

GPUI Kit 0.9.1 and gpui-webview 0.9.1 run on gpui-fast through their `gpui-fast` feature (gpui-webview checks that the two agree). That feature asks for the crates.io `gpui-fast*` 0.1.14 packages, and GPUI Kit still names the `gpui-pre` 0.3.12 snapshot besides, so Cargo would build three GPUIs; the shims in `compat/` carry those names and versions and re-export the workspace's GPUI, and `[patch.crates-io]` swaps them in.
`Cargo.lock` was seeded from Zed's own lockfile at that commit, and Zed's `[patch.crates-io]` entries are repeated in the workspace manifest because a dependency's patches do not apply.

GPUI itself, gpui-fast's macOS platform and GPUI Kit's components, foundation and webview are the copies in `patches/`, upstream at those pins plus Lattice's diffs: element scale and letter spacing in GPUI, a lab switch for uncomposited windows (`GPUI_LAB_IGNORE_OCCLUSION`), the overlay surface taking the first click in a window that is not key as GPUI's own view does, GPUI Kit's toasts and sheets drawn on the overlay surface so a webview island does not cover them, a dock region's last panel free to drag out, as Trellis lets it, and a webview island's page placed and zoomed with the interface size. `script/check-patches` rebuilds them from upstream and fails on any difference; `patches/README.md` has the provenance.

### Lattice's look

The app draws what the Tauri app draws: the parity target is the running app as Paper's App screens page records it, with `design-system/tokens.json` (exported from Paper) as the source of every value.

- `crates/lattice-ui/src/tokens/` is generated from the JSON, and from `design-system/code-themes.json` for the code themes; a test fails while they disagree. After a Paper export, or after `node design-system/code-themes.mjs` re-exports the Tauri app's code themes, regenerate with `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
- `Palette` resolves every colour role for an appearance, tint and accent preset the way `src/styles/theme.css` derives them; GPUI Kit and Zed's editor are themed from it (`kit.rs`, `editor_theme/`, one Zed theme per Lattice code theme), so their own components start in Lattice's colours.
- The panels are Trellis's, ported (`crates/trellis`), and wear Lattice's skin (`shell/skin.rs`, from `src/trellis/trellis.css`): rounded cards whose surface follows the selected view, 40px strips of pill tabs, the divider's grip in the accent after a hover delay, Trellis's drop slot with "Add as tab". A strip short of room gives way as Lattice's Trellis patch plans it (`planHeader`), from the tabs' shaped widths.
- Fonts: Inter, Ioskeley Mono and Instrument Serif are bundled (`script/make-fonts` writes them). The private Timeless faces are embedded at build time by `crates/lattice-ui/build.rs` when `LATTICE_PRIVATE_FONTS_DIR` (default `~/Downloads/Timeless-Type-Family-1.094`, empty for none) holds the complete download, as the Tauri build embeds them; `LATTICE_PRIVATE_FONTS_REQUIRED=1` fails the build without them. The download's `LICENSE.pdf` is embedded, unmodified, with them (`lattice_ui::fonts::font_license()`); a download without it counts as incomplete, so the faces are not embedded. The app never reads them at run time, and they are never committed.
- `LATTICE_APPEARANCE=light|dark` fixes the appearance instead of following the system's.
- Hover, motion, reveal, scrollbars and nested corners are Fluid Functionalism's, as the Tauri app has them: one gliding fill per list (`fluid_hover`), the motion tiers and `Tween` (`motion`), a sliding selection plate (`sliding`), `reveal`, Lattice's scrollbar (`scrollbar`) and `shape::Nest`.
  [`docs/design-system.md`](docs/design-system.md) is their API; use them rather than a per-row hover, a hand-written duration or a restated radius.
- Components (`lattice-ui/src/components/`) follow Paper's Components boards; hover and press fade on the motion tiers (`interaction.rs`). Menus, selects and popovers spring from their trigger from 95%, tooltips grow from 98%, dialogs and sheets rise from 98%, and toasts drop in from 96%, each on its tier as the Tauri app's CSS has it (`motion::Entrance`, drawn with GPUI's element scale). Type roles set normal tracking, and an uppercase micro label opens it to the caps tracking (`Tracking::Caps`). `lattice-gpui --gallery` draws them all on one sheet (`LATTICE_GALLERY_PAGE=2` for the overlays and surfaces) and, with `LATTICE_SHOT_OUT` and `--features offscreen-shots`, saves it.

### Settings and languages

The settings are the Tauri app's (`src/settings/app-settings.ts`), field for field and read the same way (`crates/lattice-settings`): each field is read on its own, and one that is missing or unusable takes its default. They live in `settings.json` in the state directory (`LATTICE_GPUI_STATE_DIR` moves it; a scripted run keeps them in memory), written whole on every change and checked every second, so an edit made outside the app applies (one that does not parse, or is from a newer version, is left as it is and the settings in use stay; at startup, or when a choice is next saved over it, such a file is moved aside to `settings.json.unreadable`, or `.unreadable.2` and so on when that name is taken, and at startup the defaults apply). When there is no file, the first run reads the Tauri app's choices from its WebKit storage (`~/Library/WebKit/app.leo1oel.researchwriter/WebsiteData`, a copy of each LocalStorage database, never the database itself; `LATTICE_GPUI_TAURI_STORAGE` names another directory, empty for none) and writes them as the file.

Every string the app shows goes through `lattice-i18n`'s `t!`, keyed by its English as Lingui keys it, so the Chinese is the Tauri app's own (`../src/locales/zh-CN/messages.po`, read at build time) wherever the two apps share a string; what only the GPUI app says is in `crates/lattice-i18n/locales/zh-CN.po`. `cargo test -p lattice-i18n` fails while a string the app translates has no Chinese, the port of `scripts/check-i18n-coverage.mjs`. The interface follows the system's first preferred language unless Settings fixes one; a scripted run is in English unless its settings say otherwise.

### Webview islands

The surfaces that stay web content (the Agent, boards, sheets, slide decks, the visual Markdown editor, the HTML preview) were iframes of the Tauri app; here each is an island, `lattice_webview::Island`, in its panel: a WKWebView (WebView2, WebKitGTK) that gpui-webview places between GPUI's base content and its overlay surface, so menus, popovers, tooltips, the palette, dialogs and toasts, all drawn deferred, stay above the page.
The HTML preview is the first (`src/html_preview.rs`, its page in `assets/islands/html-preview/`); the host gives every island the rest:

- Lifecycle: nothing is built until the island is first shown; hidden for 20 s (the Tauri app's `HIBERNATE_AFTER_MS`) it is torn down and built again when shown, the owner restoring the page's state when it reports ready; what is posted before then waits, the latest of each event only. An island that never hibernates (the Agent) lands with the Agent. The owner says when it is shown, since a native view does not hide by not being painted; an island also hides itself while it is missing from the window's last frame (another panel maximized over it), checked after every layout change and every 250 ms while shown.
- Reveal: until the owner says the page has drawn, it is laid out at its size but clipped away, so the GPUI placeholder (the HTML page skeleton) shows and the first visible frame is a loaded one.
- The bridge (`assets/bridge.js`, injected into the main frame): events and requests both ways, the page's focus and presses, the theme as the Tauri app's CSS variables, and the app's shortcuts typed in the page. Only the island's own page may speak: each webview gets a random token that only its main frame's bootstrap holds and sends with every message, and a message without it, or from a frame not served by the island protocol, is dropped, as is a shortcut the host did not relay to the page. No frame navigates anywhere but the island's bundle, and a project file is served with `Content-Security-Policy: sandbox`, so an authored page cannot load one as a document of the island's.
- The local asset protocol: a page and its scripts are compiled into the binary and served under `lattice://island/bundle/…` (`http://lattice.island/…` on Windows), and a project file only once the host grants it, at `…/asset/<path>`; nothing outside the project, through `..`, an absolute path or a symlink, whatever was granted. The file bridge reads the granted files by the same rule (`files:read-text`); writes and wider reads land with the first island that needs them (sheets and boards).
- Focus: a click in the page moves GPUI's focus to the island (AppKit's first responder decides whether the page has the keyboard), so the key context is the island's; the page then claims only the app's own shortcuts there (from the keymap, evaluated in that context, never the editing keys and never while an input method composes) and the host dispatches them after the current update, with AppKit's first responder back in GPUI's view when the keys moved GPUI's focus elsewhere (the Phase 0 spike's fix).
- Overlays: anything drawn over a page must be deferred, and must not cover the page with a hitbox, since the overlay surface takes every point one of its hitboxes covers; GPUI's presses outside the page reach it as `host:outside-pointerdown`. While a panel is dragged every island steps aside, so the drop targets under it work. The Trellis workspace's floating panels (and, above them, its drop slot and a dragged panel) are drawn deferred too, so one floating over a docked island is above the page; an island floating in a panel is hosted on the overlay surface itself, so a menu or toast that overlaps it is under its page.
  On Windows, gpui-webview 0.9.1 does not compose WebView2 yet, so a GPUI overlay over a page (the preview's zoom controls, a menu, a toast) is under it until the plan's snapshot-and-hide is in; the island checks run on macOS.

### The editor adapter

`crates/lattice-editor` puts one Lattice-shaped API over Zed's editor, the way the Tauri app builds its source editor out of CodeMirror extensions (`../src/editor/`). `LatticeEditor` wraps Zed's `Editor` over a buffer, and a feature says what to show in buffer offsets, in named layers that it replaces whole:

- marks (an underline, wavy or straight, the ink, a strike, the weight) and highlights (a wash behind the text): Zed's text and background highlights, anchored so they follow later edits; Zed keys them by a closed enum, so each layer's styles take slots of a key nothing else in the app sets;
- the source gutter (`adapter/gutter_column.rs`), in place of Zed's, which sizes itself in whole character widths: line numbers and fold markers laid out as CodeMirror's (`src/editor/source-gutter.ts`), with the editor element inset by it and by the room the host keeps at the right (the outline rail's), so the text and its wrap match CodeMirror's; a language gives it what each line folds (`folds::FoldSource`; LaTeX's is `latex/folding.rs`, the Tauri app's text scan), and the overlay scrollbar is lattice-ui's shared one in the editor's feel;
- gutter marks: a dot beside a line, painted over the gutter's free left edge by the adapter's overlay, with an optional hover card; nothing in the app sets one yet (the Tauri app's annotation pins will), so the end-to-end scenario proves them with a layer of its own;
- block widgets: Zed's blocks, between lines;
- hover cards: Zed's editor hovers only for language servers, so the overlay runs the pointer itself: each provider names its range and builds its card, and every provider's card at the pointer (over one of the range's characters, on any row soft wrap puts it, never past a line's end) opens after it rests 300 ms (CodeMirror's `hoverTime`), stacked in provider order as CodeMirror's hover host stacks its sources' tooltips (a citation card over the lint card of a diagnostic on the same key).
  The stack rises above its ranges on the pop tier (below them when the editor has no room above) and stays inside the editor.
  While the pointer stays by the stack, it follows the ranges under the pointer: a card whose range the pointer comes onto joins after the hover delay with its own entrance, and one whose range it leaves goes after a 150 ms grace; on ranges none of which has a card shown, the stack closes at once and their cards open after the hover delay.
  The stack closes when the pointer leaves the ranges and the cards, on a key or an edit;
- completion sources, given to Zed's completion menu through one provider; each source filters and orders its own options, as the Tauri app's citation source must, and a pick can put the caret inside the inserted template and open the menu again (a `\cite{}` lists the keys next);
- remote carets, drawn as Overleaf draws them (`../src/overleaf/overleaf-editor-extensions.ts`): a 2px bar and dot in the person's colour, the name for a moment when the caret arrives or moves (2 s, then a short fade) and while the pointer rests on it, below the caret near the top edge.

Positions come from the two questions Zed's editor answers for input methods (`bounds_for_range`, `character_index_for_point`) and its display snapshot, read in the same frame as the editor's own paint.
The proof of the others is a real Lattice use in `src/latex/`: TexLab's diagnostics (lattice-core's TexLab pool) as wavy marks in CodeMirror lint's colours with the lint card, and no gutter marker, as in the Tauri app; the citation card (key, title in the reading face, authors, venue, source, Go to entry, Copy key) and the reference card from the project's index (lattice-core's `citations` and `references`); command, environment, package, citation-key and label completion, with the Tauri app's vocabulary ported entry for entry; Harper's spelling and grammar findings (or a LaTeX document's Hunspell dictionary's) as wavy marks with the lint card (`src/latex/spelling.rs`). Not yet (later editor slices): the rest of the Tauri app's LaTeX features and Vim's ex commands.

### The LaTeX language

`crates/lattice-editor/languages/latex` holds the language config and a highlight query written for this prototype against the latex-lsp tree-sitter grammar (`codebook-tree-sitter-latex`, MIT).
Zed's community LaTeX extension was not used: it carries no license.

### The PDF preview

PDFium (through `pdfium-render`) runs on a dedicated thread, because neither PDFium nor its documents may cross threads; one worker serves every viewer (the live PDF, the root documents' tabs, the separate window, every main window), since pdfium-render binds the library once per process. Drawing what is on screen goes first, and a search reads the pages one at a time behind it, so a long document's search never holds up a scroll.
The PDF is read into memory on every (re)load, so latexmk can rewrite it while it is shown, and Windows does not refuse the write.
Pages are laid out from their sizes at once (`pdf/layout.rs`, the Tauri viewer's column: 8px of border, 10px between pages) and scroll in one container; only the pages near the viewport are drawn, and images two pages beyond the visible ones are released from memory and from the GPU atlas. A page larger than 6 million device pixels at its zoom is drawn at that size, with the part on screen drawn again at full size on top, as PDF.js caps its canvases.
A zoom stretches the pages' images at once and draws them again once it rests (80 ms), as the Tauri app previews a zoom as a transform.
A rebuild compares each page's signature (`lattice-core`'s `pdf_pages`) with the last copy's: a page that draws the same keeps its image and text, and a changed one keeps its old image until the new one is drawn. A new page count, outline or page size shows the document anew.
Dark pages are the Tauri app's CSS filter, `invert(0.86) hue-rotate(180deg)`, applied to PDFium's bitmap, so hues keep and the SyncTeX mark, search hits and the selection keep their own colours. The choice, the fit and zoom a viewer opens with, and, per project, whether its PDF is in the separate window and where that window was left are kept in `pdf.json` in the app's state directory (`LATTICE_GPUI_STATE_DIR`; a scripted run keeps them in memory).

### The build

The build is `lattice-core`'s `latex::build`, the Tauri app's own: the main document from the project's manifest (or a compilable `.tex` open in the editor, which it adopts), its engine, rc-file handling, preamble format, stale-build recovery and log diagnostics.
While it runs, the Build button's card fills in the passes latexmk announces; one build runs at a time, and a build asked for meanwhile runs once it ends, standing for every ask made in between.
A build after a save is unattended, as the Tauri app's automatic builds are, so a failing document nothing changed in is not typeset again: its errors are restated from the log the failed build left.

`crates/lattice-gpui/src/build/` ports the Tauri app's build surfaces line by line, with their tests: `compile-diagnostics.ts` (`diagnostics.rs`), `compile-explain.ts` (`explain.rs`), `build-result-text.ts` and `build-outcome.ts` (`outcome.rs`), the diagnostics card (`card.rs`), the Build button's sequence (`sequence.rs`), `tex-setup.ts` and the setup dialogs (`tex_setup/`), the TeX doctor pane (`doctor.rs`) and the status bar's word counts (`word_count.rs`).
The doctor and the installers are lattice-core's (`doctor::run`, `tex_setup::install_tex`, `install_dependency`); the scripted scenarios replace them with a stand-in (`tex_setup::backend::StubTexSetup`), so no run of them installs anything or asks for an administrator.

### Saving and outside edits

The editor saves the way the Tauri app's open documents do (`../src/app/use-document-save.ts`, `use-document-autosave.ts`, `use-document-disk-sync.ts`, `vanished-file.ts`): through `lattice-core`'s editor transaction, with the text the buffer grew from as the base of a three-way merge, so an outside edit is kept and a clash is marked with conflict markers and a notice. The file is checked every 2.5 s and whenever the project watcher names it.

### SyncTeX

Both directions are `lattice-core`'s (`latex::forward_search`, `latex::inverse_search`). A jump to the PDF saves first and builds when the PDF is older than the sources, as the Tauri app's `ensureCompiled` does; the PDF scrolls the line's box to the middle of the panel and marks it with an accent box that fades after 1.44 s.
When the live PDF is in its own window, that window comes forward with the mark, and the jump does not reveal the PDF in the workspace.

## Scripted runs

```sh
node ../scripts/gpui-build.mjs                   # release build with offscreen-shots, in the shared build tree
cp -R fixtures/e2e /tmp/lattice-gpui-e2e        # the scenario edits and builds its project
target/release/lattice-gpui /tmp/lattice-gpui-e2e --scenario e2e --out e2e.json
```

`e2e` runs on macOS and Windows; `islands`, `perf`, `memory`, `ime`, `ime-protocol`, `shot`, `parity` and `pdf-shots` are macOS only.

A scripted run keeps the workspaces and the projects' layouts in memory, so it neither reads nor changes the writer's own; `LATTICE_GPUI_STATE_DIR` names a directory for them instead (an ordinary run keeps them in the system's data directory, under `lattice-gpui/`). `LATTICE_WINDOW_SIZE=1015x680` opens the window at another size, as a smaller screen would (GitHub's runners shrink it to about 1015px wide).

- `e2e`: opens a project through `lattice-core`, builds, jumps from the caret to the PDF and back with a native double-click (SyncTeX), autosaves after a pause in typing (and builds), reloads an outside edit into a clean buffer and merges one made while the buffer holds edits, types a broken macro with native key events, saves with ⌘S / Ctrl+S, builds, follows the error to its line, searches, checks Vim's `x`, repairs the file outside Lattice and rebuilds, checks the build's card (the passes, the explained error, the unattended rebuild that restates an unchanged failure, a typo's fix, a missing package's install with the stand-in installer, clean and clean rebuild, stopping a build that loops), the TeX doctor and the setup wizard (stand-in), and the manuscript's word count, a TODO typed in a note counted in the status bar and the editor's overlay scrollbar shown while the text scrolls and hidden once it rests, and the wheel over the line numbers scrolling the text (`scenario/e2e/status_bar.rs`), the source gutter putting the text where the caret before it is, a fold marker shown over the gutter and folding and unfolding the preamble under native clicks, the Source / Visual switch offered for a `.tex` file only, and the outline rail marking main.tex's sections, opening when the pointer rests on it and jumping to a heading (`scenario/e2e/source_chrome.rs`), creates, renames, moves and deletes a file in the tree, duplicates one with ⌘C and ⌘V, opens files with quick open (by name, `:3`, `@` a section), finds a line with Find in project and opens it with F3, rewrites a file with Replace in project and sees the open editor follow, opens and closes New project, opens a window without a project on the welcome screen listing the project it opened, and, only with `LATTICE_E2E_DRAG` set, drags an editor tab into the PDF's panel with native mouse events (off by default because it missed the tab in CI's narrow window).
  Before those checks it runs the window's own steps on the Trellis workspace: the PDF dragged by its tab with native mouse events to the documents' left edge (a new split) and into their middle (a tab, its own panel closing up), the focused panel maximized and restored, the Writing preset and the way back, a new workspace keeping its own arrangement (the dot until it is saved), Project closed from its tab and brought back beside the Agent from the Panels toggle, the PDF floated and docked, a native double click on the float's strip background over a docked panel's strip reaching only the float (its view focused, the panel beneath not maximized), the layout read back as a relaunch reads it, the command palette listing the commands, and ⌘W on the focused document closing its tab with the keyboard left in the window (the palette still opens, ⌘⇧T brings the tab back).
  A native drag has a frame drawn before its press and after every event, since input lands on the last frame's hitboxes; a window the platform is not presenting (covered, or on a locked screen) draws none itself, so the scenario draws it, and the step's detail records how many the window drew.
  It also jumps from a `.bib` entry to the PDF, and checks that closing a dirty tab or a window within the autosave pause saves what was typed, that closing the tab of a file deleted outside Lattice takes down its notice, and that with edits that cannot be saved, "Open in New Window" keeps the window and opens no other, and opening another project keeps the one shown.
  In `main.tex` it checks the editor adapter: the citation and reference cards open when native mouse moves rest on a key or label and close when the pointer leaves, remote carets draw and name themselves and fade, a block widget pushes the lines below it down, a gutter mark set on a line is painted there and opens its card, TexLab's diagnostic for an unknown `\ref` shows as a mark whose card opens and clears once the reference goes, and with the bibliography unlinked, TexLab's diagnostic on the cited key opens its lint card under the citation card (both skipped without `texlab`), a card opens over its range's last character and not from the space past its line's end, a `.tex` file renamed to `.txt` is never synced to TexLab, and native keys complete a citation key, `\textbf`, and a package in the middle of `\usepackage`'s list (prefix matches first, the bare name inserted). With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window at each card, the carets and the completion menus.
  Its PDF steps write and build a second root document of twelve pages (`scenario/e2e/pdf.rs`): its PDF becomes the live one and main.tex keeps a tab of its own; then the outline (its heading lines kept past a comment block of wide characters), page navigation and a typed page, zoom and both fits, ⌘F / Ctrl+F with the query typed and Enter, a section link clicked with the native mouse and undone with Back (and links to a file or an app's own scheme left unfollowed), a selection dragged with the native mouse and copied with ⌘C / Ctrl+C, dark pages, a rebuild that changes one page and redraws only that one, the page window letting go of far pages, and the separate window, opened again when its project is shown again and leaving a panel it shares with Project on screen at its width with Project in it, and main.tex's tab asking for a build that Stop then drops, so the next build compiles the document in front; building main.tex again trades the two tabs back. Then a second main window opens on the project, and its PDF must load and draw at the window's scale factor, through the same process-wide PDFium worker.
  It opens Settings with ⌘, (native keys), searches it and opens the row found with Enter, checks that a tint, an accent, a code theme and the editor's size apply at once, that the keymap turns Vim and Emacs on, that the interface switches to Simplified Chinese and back, that with Manual only builds an edit made outside the app reloads the open file and starts no build, that turning the Git tool off under Title bar tools takes its button out of the title bar and turning it on puts it back, that an edit to the settings file made outside the app applies, and that Escape closes it.
  Then Settings' live controls (`scenario/e2e/live_controls.rs`): the interface size with ⌘= / ⌘− / ⌘0 as native keys (the window's layout and scale, the size pill) and from Settings, interface sounds heard for a build the writer asked for and a running notice settling and not heard when off, spell checking marking and carding a misspelling, adding it to the project's dictionary, off and on and in Simplified Chinese, and translucency's vibrancy and glass at each strength (or the reason there is none).
  It ends by quitting with text typed and not yet saved, naming the file and the text in the result's `after_quit`; the file holds the text once the app has exited, which CI checks.
  It needs `chapters/intro.tex` and `references.bib` in the project, and `main.tex` as the fixture has it.
- `islands`: the webview island checks the `e2e` scenario also runs on macOS, alone, for work on the islands (an HTML file's Preview): it opens an HTML file and checks that its island is built on first show and revealed once loaded, that the asset protocol serves the image the host granted, that the page's scroll and a zoom cross the bridge (a native click on the zoom controls over the page reaching GPUI), the page's view covering the island and the page zoomed with the interface at 120% and 90%, the theme, that a native click gives the page the keyboard and ⌘K / Ctrl+K typed there opens GPUI's palette, that a toast over the page is drawn above it (macOS, from a composited capture of the window, skipped where the screen cannot be captured), Edit, Split and Preview, a tab switch hiding the page, and its hibernation and return.
- `perf`: Lattice's perf-lab `longTex` scenario: open `long.tex`, fling 200 wheel events of 120 px 8 ms apart with a per-frame meter, click a line, type with 110 ms between keys, then read `footprint`.
- `memory`: `footprint` after opening the project, after opening `long.tex`, and after scrolling through the whole PDF.
- `ime`: selects a Pinyin input method for the window and types `nihao` + space with native key events.
- `ime-protocol`: makes the `NSTextInputClient` calls an input method makes (marked text per keystroke, then the commit) directly on the view.
- `shot`: waits for the project's PDF to draw, then saves the window as `LATTICE_SHOT_OUT` (a PNG), for side-by-side look reviews against Paper's App screens. Built with `--features offscreen-shots` it draws and reads the frame back itself, so the screen may be locked; otherwise it uses `screencapture`, which needs the window on an unlocked screen.
- `pdf-shots`: the PDF viewer's states one after another (at rest, Find with its hits, the ⋯ menu, the Outline, a selection, dark pages, the wide toolbar, the panel while the PDF is in its own window and that window, no PDF yet), saved as PNGs in `LATTICE_SHOT_DIR`, for a look review against the Tauri app.
- `parity`: the parity harness's half of a scene (below; `LATTICE_PARITY_SCREEN=settings` for Settings): the pointer parked, the PDF shown and the build chip staged as a clean 1.2 s build; then it saves the window as `LATTICE_SHOT_OUT` and lists every named region's bounds and the text style of each run of text in it in the result. With `LATTICE_PARITY_SCREEN=welcome` it stages the welcome screen instead, with the recent projects the harness's reference stages and motion reduced.

On macOS the keys go through the active input source, so select an ASCII layout (ABC, U.S.) before running `e2e`; a Pinyin input method turns the typed macro into candidates.
On macOS, input is sent the way Lattice's perf lab sends it (`../src-tauri/src/perf_lab.rs`): `NSEvent`s through `-[NSWindow sendEvent:]`.
On Windows, keys are posted to the window's message queue, so GPUI's own message loop translates them as it does typed keys, and mouse messages are sent to the window procedure; neither needs the window in front.

Only one scenario on the machine drives input at a time.
Native clicks, keys and window focus land in whichever app is in front, so two `e2e` runs at once (two worktrees, two validation runs) fail each other's steps.
`script/e2e` runs under a machine-wide e2e lock (`../scripts/with-gpui-e2e-lock.mjs`, a directory at `/tmp/lattice-gpui-e2e.lock` that `../scripts/lib/gpui-lock.mjs` manages the way it manages the build lock), and the parity harness takes it around its GPUI captures, since the `parity` scenario brings its window to the front.
A second run prints `waiting for the GPUI e2e lock held by <pid> <worktree>` and starts when the first finishes; a lock left by a process that died is taken over.
The e2e lock is separate from the build lock, so one worktree's build runs alongside another's e2e run.

## Parity harness

`parity/` renders the same scene in the Tauri app's frontend and in this app, and diffs them region by region:

```sh
node ../scripts/gpui-build.mjs                                   # release build with offscreen-shots (or cargo build --release, on an unlocked screen)
node parity/run.mjs --out /tmp/lattice-parity                    # from gpui/; --theme light,dark --screen mainWindow,welcome,settings
```

- The reference is the Tauri frontend on the mock-backend page (`pnpm perf:bench --serve`, which `run.mjs` starts unless given `--bench-url`), staged by the functions that draw Paper's App screens (`../design-system/screens/scenes.mjs`), at the GPUI window's size and scale (1440×900 @2x on a Retina Mac). Every run also saves the page as `serialize.js` draws it into Paper, its layers named after the regions.
- The GPUI side is `--scenario parity` on a copy of the tutorial project. Both apps show the tutorial's PDF as the web demo ships it (`../tools/web-demo/content/compiled/main.pdf`).
- The regions are listed per screen in `parity/regions.mjs`, as a selector in the Tauri app's DOM; this app records the same names with `lattice_ui::parity` probes (the components take `.parity(name)`), and each run of text in a region with a text probe. The probes are not even added to the tree outside a parity run.
- Checks, per screen and theme: each region's bounds within ±1 px; each run of text's family, size (after the face's `size-adjust`), weight and line height, the two apps' runs in a region matched by their text, then in order; each chrome region's ground colour within ΔE2000 1; and the share of pixels that differ visibly (ΔE2000 > 2.3) outside text, the PDF pages and what changed between the reference's two runs, within three times that run-to-run noise (at least 0.1%). What changed between the GPUI app's two runs is reported on its own line and stays in the comparison.
- It writes `report.md` and `report.json`, and per screen and theme a side-by-side image (reference, GPUI, heatmap) and the full-resolution heatmap; the captures are under `runs/`. It exits 0 once the report is written, whatever it found.

CI's macos job writes the report after the e2e scenario and uploads it as the `gpui-parity-macos` artifact; it does not fail the job yet. The runner's screen shrinks the window to about 1015 px wide, so CI compares the two apps at that width. The Main window, the Welcome screen and Settings are ported so far (`LATTICE_PARITY_SCREEN=settings` opens Settings over the window in the scenario); the other App screens follow in `parity/regions.mjs`.

## Reference projects

Checked on 2026-11-11 before reusing anything.
Only GPUI Kit, gpui-webview, gpui-fast, Zed's crates, pdfium-render, the LaTeX grammar and Lattice's own `lattice-core` are dependencies; no code was copied, besides the upstream crates vendored with diffs in `patches/`.

| Project | License | GPUI it pins | Used here |
|---|---|---|---|
| [GPUI Kit](https://github.com/longbridge/gpui-kit) 0.9.1 | Apache-2.0 | `gpui-pre =0.3.12` (Zed `d2a4fb6`), or gpui-fast 0.1.14 with its `gpui-fast` feature | dependency: dock, tree, buttons, theme (feature `gpui-fast`; its components crate vendored with a diff, `patches/`) |
| [Zed](https://github.com/zed-industries/zed) `d2a4fb6` | GPL-3.0-or-later (editor, search, Vim, workspace, project); Apache-2.0 (GPUI) | in-tree `gpui` 0.2.2 | dependency: GPUI, editor, search, Vim, project (the completion menu's items) |
| [gpui-fast](https://github.com/longbridge/gpui-fast) `bbf6dea` | Apache-2.0 (modified fork of Zed's GPUI) | tracks Zed `d2a4fb6` | dependency: the app's GPUI (two crates vendored with diffs, `patches/`) |
| [gpui-webview](https://crates.io/crates/gpui-webview) 0.9.1 | Apache-2.0 | `gpui-kit` 0.9.1, feature `gpui-fast` | dependency: the webview islands (`crates/lattice-webview`; vendored with a diff, `patches/`) |
| [Ely GPUI Components](https://github.com/ELY-Open-Source/Ely-GPUI-Components) | MIT | `gpui-pre =0.3.11` (Zed `f816e1f`) | not needed: nothing was missing from GPUI Kit |
| [pdf-reader](https://github.com/joelfickson/pdf-reader) | MIT | `gpui =0.2.2` | reference for the PDFium approach (BGRA bitmaps into `RenderImage`) |
| [kkpdf-zed](https://github.com/kk376/kkpdf-zed) | Apache-2.0 OR GPL-3.0-or-later | none (engine only) | reference |
| [zorite](https://github.com/packetThrower/zorite) / `gpui-pdf` | GPL-3.0-or-later (app), MIT (`gpui-pdf`, `ratex-gpui`) | `gpui-pre` 0.3.9 (Zed `93d7456`) | reference (pure-Rust hayro renderer, the alternative to PDFium) |
| [Glim](https://github.com/glimapp/glim) | MIT | `gpui-kit =0.7.1` → `gpui-pre` 0.3.8, vendored | reference (PDFKit overlay, macOS only) |
| [quiet-md](https://github.com/s1dashu/quiet-md) | MIT | `gpui` 0.2.2, vendored | reference for later (rich-text editing) |
| [pdfium-render](https://crates.io/crates/pdfium-render) 0.9.5 | MIT OR Apache-2.0 | none | dependency |
| [PDFium binaries](https://github.com/bblanchon/pdfium-binaries) chromium/8125 | BSD-3-Clause and bundled notices | none | downloaded by `script/fetch-pdfium` |
| [tree-sitter-latex](https://github.com/latex-lsp/tree-sitter-latex) (`codebook-tree-sitter-latex` 0.6.1) | MIT | none | dependency |
| Lattice's `lattice-core` (`../src-tauri/lattice-core`) | Apache-2.0 | none | dependency (path): the backend both apps share |

tldraw is not used.

