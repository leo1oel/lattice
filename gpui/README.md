# Lattice on GPUI (preview)

A native GPUI version of Lattice's LaTeX writing flow, growing beside the Tauri app in this repository.
The Tauri app in `../src` and `../src-tauri` keeps shipping; nothing here is built, tested or released with it, and `gpui/` is its own Cargo workspace.

Its backend is the Tauri app's own: `lattice-core` (`../src-tauri/lattice-core`), the crate both apps share. What it does so far, and nothing more:

1. Opens a project folder as the Tauri app does (a folder Lattice did not create is adopted the same way), with the Project tree on the left: the same files shown and hidden, New file, New folder, Rename, a dragged row moved into a folder, Delete, Set as main document, Show hidden files.
2. Edits sources in Zed's editor with LaTeX highlighting in Lattice's code themes, search (Zed's buffer search bar) and an optional Vim mode (Zed's Vim); in a `.tex` file, a card for the citation key or `\ref` label under the pointer, completion of commands, citation keys and labels, and TexLab's diagnostics (when `texlab` is installed), through Lattice's editor adapter (below).
3. Saves as the Tauri app does: after a pause in typing, on leaving the editor, and before a tab or window closes or the app quits, merging an edit made outside Lattice since the file was loaded rather than writing over it; an outside edit reloads a clean buffer, and a file moved or deleted outside Lattice is followed, closed or held with its edits.
4. Shows the PDF on the right, rendered natively by PDFium, and jumps between it and the source with SyncTeX: ⌘⇧J / Ctrl+Shift+J (or the PDF toolbar's locate button) marks the caret's line in the PDF, and a double-click in the PDF opens its source line.
5. Builds with lattice-core's latexmk build on one click (or ⌘B / Ctrl+B), and after each save and each outside edit it loads (the Tauri app's default automatic builds), reloads the PDF in place, and lists errors that jump to their line.
6. Puts every panel in GPUI Kit's dock: tabs drag between the center and the docks, docks resize and collapse.

Not yet: the visual Markdown editor, Overleaf, the papers library, the Agent panel, canvas, spreadsheet, slides, live preview and i18n.

## License

This directory is GPL-3.0-or-later ([`LICENSE`](LICENSE)), because the app links Zed's GPL-3.0-or-later crates (editor, search, Vim, workspace).
`compat/` is Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)), and the upstream crates in `patches/` keep their Apache-2.0 license, with Lattice's diffs under it.
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
| ⌘S / Ctrl+S | Save |
| ⌘⇧J / Ctrl+Shift+J | Mark the caret's line in the PDF (SyncTeX); a double-click in the PDF goes back |
| ⌘F / Ctrl+F | Find in the current file (Zed's search bar: regex, case, whole word, replace) |
| Zed's default keymap | Everything else in the editor |

"Vim mode" in an editor's ⋯ menu turns Zed's Vim mode on for every editor; `LATTICE_GPUI_VIM=1` starts with it on.

## CI

`.github/workflows/gpui.yml` runs only when `gpui/**`, `lattice-core` (`../src-tauri/lattice-core/**`, which the app builds on), the workflow itself, one of the design-system exports `crates/lattice-ui` generates from changes (`../design-system/tokens.json`, `../design-system/code-themes.json` and what that is generated from; the workflow lists them), or the scene staging the parity report uses (`../design-system/screens/`).
Its `code-themes` job fails while `code-themes.json` is stale (`node design-system/code-themes.mjs --check`), and its `patches` job while `patches/` is not upstream plus its diffs (`script/check-patches`). A separate workflow, `.github/workflows/gpui-patches.yml`, runs only when `patches/` changes: it applies the diffs to gpui-fast at the pin and runs the tests they add (element scale, letter spacing).
On macOS and Windows it builds the app (release profile), runs the unit tests and the `e2e` scenario on `fixtures/e2e`; on macOS it then writes the parity report (below), which does not fail the job. `lattice-core`'s own tests run with the Tauri app's (`ci.yml`).
macOS builds with TeX Live and TexLab (so the e2e scenario checks TexLab's diagnostics); Windows builds with MiKTeX and no TexLab, where that step reports itself skipped.
The Chinese input method (Microsoft Pinyin on Windows) and MiKTeX's own package-install prompts are checked by hand; CI cannot drive them.

## How it is put together

```
crates/lattice-gpui   the app: shell (titlebar + dock), project, file tree,
                      editor panel, PDF panel (PDFium on its own thread), build
                      panel, notices and confirmations, scripted scenarios
                      (macOS, Windows)
crates/lattice-editor the adapter over Zed's editor every editor feature
                      decorates through (marks, highlights, gutter marks, block
                      widgets, hover cards, completion sources, remote carets),
                      the LaTeX language and the LaTeX extensions on it, the
                      project's citation and label index, TexLab
crates/lattice-ui     Lattice's look: design tokens generated from
                      ../design-system/tokens.json, the palette, GPUI Kit and
                      Zed editor themes, fonts, type roles, motion, elevation,
                      icons, components and the dock's skin
../src-tauri/lattice-core
                      the backend the Tauri app runs on (a path dependency):
                      projects, the tree and its file operations, builds,
                      SyncTeX, saving with merge, the project watcher
compat/               shims that leave one GPUI (gpui-pre, gpui-fast) and one
                      SQLite (sqlite) in the graph
patches/              upstream crates with Lattice's diffs: gpui-fast's GPUI and
                      macOS platform, GPUI Kit's components (patches/README.md)
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

GPUI itself, gpui-fast's macOS platform and GPUI Kit's components are the copies in `patches/`, upstream at those pins plus Lattice's diffs: element scale and letter spacing in GPUI, a lab switch for uncomposited windows (`GPUI_LAB_IGNORE_OCCLUSION`), and GPUI Kit's toasts and sheets drawn on the overlay surface so a webview island does not cover them. `script/check-patches` rebuilds them from upstream and fails on any difference; `patches/README.md` has the provenance.

### Lattice's look

The app draws what the Tauri app draws: the parity target is the running app as Paper's App screens page records it, with `design-system/tokens.json` (exported from Paper) as the source of every value.

- `crates/lattice-ui/src/tokens/` is generated from the JSON, and from `design-system/code-themes.json` for the code themes; a test fails while they disagree. After a Paper export, or after `node design-system/code-themes.mjs` re-exports the Tauri app's code themes, regenerate with `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
- `Palette` resolves every colour role for an appearance, tint and accent preset the way `src/styles/theme.css` derives them; GPUI Kit and Zed's editor are themed from it (`kit.rs`, `editor_theme/`, one Zed theme per Lattice code theme), so their own components start in Lattice's colours.
- The dock keeps GPUI Kit's behaviour and wears Lattice's skin (`dock.rs`): rounded panel cards on the chrome, 40px strips of pill tabs, no dividers.
- Fonts: Inter, Ioskeley Mono and Instrument Serif are bundled (`script/make-fonts` writes them). The private Timeless faces are embedded at build time by `crates/lattice-ui/build.rs` when `LATTICE_PRIVATE_FONTS_DIR` (default `~/Downloads/Timeless-Type-Family-1.094`, empty for none) holds the complete download, as the Tauri build embeds them; `LATTICE_PRIVATE_FONTS_REQUIRED=1` fails the build without them. The download's `LICENSE.pdf` is embedded, unmodified, with them (`lattice_ui::fonts::font_license()`); a download without it counts as incomplete, so the faces are not embedded. The app never reads them at run time, and they are never committed.
- `LATTICE_APPEARANCE=light|dark` fixes the appearance instead of following the system's.
- Components (`lattice-ui/src/components/`) follow Paper's Components boards; hover and press fade on the motion tiers (`interaction.rs`). Menus, selects and popovers spring from their trigger from 95%, tooltips grow from 98%, dialogs and sheets rise from 98%, and toasts drop in from 96%, each on its tier as the Tauri app's CSS has it (`motion::Entrance`, drawn with GPUI's element scale). Type roles set normal tracking, and an uppercase micro label opens it to the caps tracking (`Tracking::Caps`). `lattice-gpui --gallery` draws them all on one sheet (`LATTICE_GALLERY_PAGE=2` for the overlays and surfaces) and, with `LATTICE_SHOT_OUT` and `--features offscreen-shots`, saves it.

### The editor adapter

`crates/lattice-editor` puts one Lattice-shaped API over Zed's editor, the way the Tauri app builds its source editor out of CodeMirror extensions (`../src/editor/`). `LatticeEditor` wraps Zed's `Editor` over a buffer, and a feature says what to show in buffer offsets, in named layers that it replaces whole:

- marks (an underline, wavy or straight, the ink, a strike, the weight) and highlights (a wash behind the text): Zed's text and background highlights, anchored so they follow later edits; Zed keys them by a closed enum, so each layer's styles take slots of a key nothing else in the app sets;
- gutter marks: a dot beside a line, painted over the gutter's free left edge by the adapter's overlay (Zed's gutter draws only its own indicators), with an optional hover card; nothing in the app sets one yet (the Tauri app's annotation pins will), so the end-to-end scenario proves them with a layer of its own;
- block widgets: Zed's blocks, between lines;
- hover cards: Zed's editor hovers only for language servers, so the overlay runs the pointer itself: a provider names the range and builds the card, which opens after the pointer rests 300 ms (CodeMirror's `hoverTime`), rises above the range on the pop tier (below it when the editor has no room above), stays inside the editor, and closes when the pointer leaves the range and the card, on a key or an edit;
- completion sources, given to Zed's completion menu through one provider; each source filters and orders its own options, as the Tauri app's citation source must, and a pick can put the caret inside the inserted template and open the menu again (a `\cite{}` lists the keys next);
- remote carets, drawn as Overleaf draws them (`../src/overleaf/overleaf-editor-extensions.ts`): a 2px bar and dot in the person's colour, the name for a moment when the caret arrives or moves (2 s, then a short fade) and while the pointer rests on it, below the caret near the top edge.

Positions come from the two questions Zed's editor answers for input methods (`bounds_for_range`, `character_index_for_point`) and its display snapshot, read in the same frame as the editor's own paint.
The proof of the others is a real Lattice use in `src/latex/`: TexLab's diagnostics (lattice-core's TexLab pool) as wavy marks in CodeMirror lint's colours with the lint card, and no gutter marker, as in the Tauri app; the citation card (key, title in the reading face, authors, venue, source, Go to entry, Copy key) and the reference card from the project's index (lattice-core's `citations` and `references`); command, environment, package, citation-key and label completion, with the Tauri app's vocabulary ported entry for entry. Not yet (later editor slices): the rest of the Tauri app's LaTeX features, Vim's ex commands, spelling and grammar.

### The LaTeX language

`crates/lattice-editor/languages/latex` holds the language config and a highlight query written for this prototype against the latex-lsp tree-sitter grammar (`codebook-tree-sitter-latex`, MIT).
Zed's community LaTeX extension was not used: it carries no license.

### The PDF preview

PDFium (through `pdfium-render`) runs on a dedicated thread, because neither PDFium nor its documents may cross threads.
The PDF is read into memory on every (re)load, so latexmk can rewrite it while it is shown, and Windows does not refuse the write.
Pages are laid out from their sizes at once and drawn only near the viewport; images two pages beyond the visible ones are released from memory and from the GPU atlas.

### The build

The build is `lattice-core`'s `latex::build`, the Tauri app's own: the main document from the project's manifest (or a compilable `.tex` open in the editor, which it adopts), its engine, rc-file handling, preamble format, stale-build recovery and log diagnostics.
While it runs, the build panel names the passes latexmk announces; one build runs at a time, and a build asked for meanwhile runs once it ends, standing for every ask made in between.
A build after a save is unattended, as the Tauri app's automatic builds are, so a failing document nothing changed in is not typeset again.

### Saving and outside edits

The editor saves the way the Tauri app's open documents do (`../src/app/use-document-save.ts`, `use-document-autosave.ts`, `use-document-disk-sync.ts`, `vanished-file.ts`): through `lattice-core`'s editor transaction, with the text the buffer grew from as the base of a three-way merge, so an outside edit is kept and a clash is marked with conflict markers and a notice. The file is checked every 2.5 s and whenever the project watcher names it.

### SyncTeX

Both directions are `lattice-core`'s (`latex::forward_search`, `latex::inverse_search`). A jump to the PDF saves first and builds when the PDF is older than the sources, as the Tauri app's `ensureCompiled` does; the PDF scrolls the line's box to the middle of the panel and marks it with an accent box that fades after 1.44 s.

## Scripted runs

```sh
cp -R fixtures/e2e /tmp/lattice-gpui-e2e        # the scenario edits and builds its project
target/release/lattice-gpui /tmp/lattice-gpui-e2e --scenario e2e --out e2e.json
```

`e2e` runs on macOS and Windows; `perf`, `memory`, `ime`, `ime-protocol`, `shot` and `parity` are macOS only.

- `e2e`: opens a project through `lattice-core`, builds, jumps from the caret to the PDF and back with a native double-click (SyncTeX), autosaves after a pause in typing (and builds), reloads an outside edit into a clean buffer and merges one made while the buffer holds edits, types a broken macro with native key events, saves with ⌘S / Ctrl+S, builds, follows the error to its line, searches, checks Vim's `x`, repairs the file outside Lattice and rebuilds, creates, renames, moves and deletes a file in the tree, and drags an editor tab into the right dock with native mouse events.
  It also jumps from a `.bib` entry to the PDF, and checks that closing a dirty tab or a window within the autosave pause saves what was typed, and that closing the tab of a file deleted outside Lattice takes down its notice.
  In `main.tex` it checks the editor adapter: the citation and reference cards open when native mouse moves rest on a key or label and close when the pointer leaves, remote carets draw and name themselves and fade, a block widget pushes the lines below it down, a gutter mark set on a line is painted there and opens its card, TexLab's diagnostic for an unknown `\ref` shows as a mark whose card opens and clears once the reference goes (skipped without `texlab`), and native keys complete a citation key and `\textbf`. With `LATTICE_E2E_SHOTS=DIR` (macOS) it saves the window at each card, the carets and both completion menus.
  It ends by quitting with text typed and not yet saved, naming the file and the text in the result's `after_quit`; the file holds the text once the app has exited, which CI checks.
  It needs `chapters/intro.tex` and `references.bib` in the project, and `main.tex` as the fixture has it.
- `perf`: Lattice's perf-lab `longTex` scenario: open `long.tex`, fling 200 wheel events of 120 px 8 ms apart with a per-frame meter, click a line, type with 110 ms between keys, then read `footprint`.
- `memory`: `footprint` after opening the project, after opening `long.tex`, and after scrolling through the whole PDF.
- `ime`: selects a Pinyin input method for the window and types `nihao` + space with native key events.
- `ime-protocol`: makes the `NSTextInputClient` calls an input method makes (marked text per keystroke, then the commit) directly on the view.
- `shot`: waits for the project's PDF to draw, then saves the window as `LATTICE_SHOT_OUT` (a PNG), for side-by-side look reviews against Paper's App screens. Built with `--features offscreen-shots` it draws and reads the frame back itself, so the screen may be locked; otherwise it uses `screencapture`, which needs the window on an unlocked screen.
- `parity`: the parity harness's half of a scene (below): the pointer parked, the PDF shown and the build chip staged as a clean 1.2 s build; then it saves the window as `LATTICE_SHOT_OUT` and lists every named region's bounds and the text style of each run of text in it in the result.

On macOS the keys go through the active input source, so select an ASCII layout (ABC, U.S.) before running `e2e`; a Pinyin input method turns the typed macro into candidates.
On macOS, input is sent the way Lattice's perf lab sends it (`../src-tauri/src/perf_lab.rs`): `NSEvent`s through `-[NSWindow sendEvent:]`.
On Windows, keys are posted to the window's message queue, so GPUI's own message loop translates them as it does typed keys, and mouse messages are sent to the window procedure; neither needs the window in front.

## Parity harness

`parity/` renders the same scene in the Tauri app's frontend and in this app, and diffs them region by region:

```sh
cargo build --release --features lattice-gpui/offscreen-shots   # or without the feature, on an unlocked screen
node parity/run.mjs --out /tmp/lattice-parity                    # from gpui/; --theme light,dark --screen mainWindow
```

- The reference is the Tauri frontend on the mock-backend page (`pnpm perf:bench --serve`, which `run.mjs` starts unless given `--bench-url`), staged by the functions that draw Paper's App screens (`../design-system/screens/scenes.mjs`), at the GPUI window's size and scale (1440×900 @2x on a Retina Mac). Every run also saves the page as `serialize.js` draws it into Paper, its layers named after the regions.
- The GPUI side is `--scenario parity` on a copy of the tutorial project. Both apps show the tutorial's PDF as the web demo ships it (`../tools/web-demo/content/compiled/main.pdf`).
- The regions are listed per screen in `parity/regions.mjs`, as a selector in the Tauri app's DOM; this app records the same names with `lattice_ui::parity` probes (the components take `.parity(name)`), and each run of text in a region with a text probe. The probes are not even added to the tree outside a parity run.
- Checks, per screen and theme: each region's bounds within ±1 px; each run of text's family, size (after the face's `size-adjust`), weight and line height, the two apps' runs in a region matched by their text, then in order; each chrome region's ground colour within ΔE2000 1; and the share of pixels that differ visibly (ΔE2000 > 2.3) outside text, the PDF pages and what changed between the reference's two runs, within three times that run-to-run noise (at least 0.1%). What changed between the GPUI app's two runs is reported on its own line and stays in the comparison.
- It writes `report.md` and `report.json`, and per screen and theme a side-by-side image (reference, GPUI, heatmap) and the full-resolution heatmap; the captures are under `runs/`. It exits 0 once the report is written, whatever it found.

CI's macos job writes the report after the e2e scenario and uploads it as the `gpui-parity-macos` artifact; it does not fail the job yet. The runner's screen shrinks the window to about 1015 px wide, so CI compares the two apps at that width. Only the Main window is ported so far; the other App screens follow in `parity/regions.mjs`.

## Reference projects

Checked on 2026-11-11 before reusing anything.
Only GPUI Kit, gpui-webview, gpui-fast, Zed's crates, pdfium-render, the LaTeX grammar and Lattice's own `lattice-core` are dependencies; no code was copied, besides the upstream crates vendored with diffs in `patches/`.

| Project | License | GPUI it pins | Used here |
|---|---|---|---|
| [GPUI Kit](https://github.com/longbridge/gpui-kit) 0.9.1 | Apache-2.0 | `gpui-pre =0.3.12` (Zed `d2a4fb6`), or gpui-fast 0.1.14 with its `gpui-fast` feature | dependency: dock, tree, buttons, theme (feature `gpui-fast`; its components crate vendored with a diff, `patches/`) |
| [Zed](https://github.com/zed-industries/zed) `d2a4fb6` | GPL-3.0-or-later (editor, search, Vim, workspace, project); Apache-2.0 (GPUI) | in-tree `gpui` 0.2.2 | dependency: GPUI, editor, search, Vim |
| [gpui-fast](https://github.com/longbridge/gpui-fast) `bbf6dea` | Apache-2.0 (modified fork of Zed's GPUI) | tracks Zed `d2a4fb6` | dependency: the app's GPUI (two crates vendored with diffs, `patches/`) |
| [gpui-webview](https://crates.io/crates/gpui-webview) 0.9.1 | Apache-2.0 | `gpui-kit` 0.9.1, feature `gpui-fast` | dependency, for the webview islands to come |
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

