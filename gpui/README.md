# Lattice on GPUI (preview)

A native GPUI version of Lattice's LaTeX writing flow, growing beside the Tauri app in this repository.
The Tauri app in `../src` and `../src-tauri` keeps shipping; nothing here is built, tested or released with it, and `gpui/` is its own Cargo workspace.

What it does so far, and nothing more:

1. Opens a LaTeX project folder, with the file tree on the left.
2. Edits sources in Zed's editor with LaTeX highlighting, search (Zed's buffer search bar) and an optional Vim mode (Zed's Vim).
3. Shows the PDF on the right, rendered natively by PDFium.
4. Builds with latexmk on one click (or ⌘B / Ctrl+B), reloads the PDF in place, and lists errors that jump to their line.
5. Puts every panel in GPUI Kit's dock: tabs drag between the center and the docks, docks resize and collapse.

Not yet: the visual Markdown editor, Overleaf, the papers library, the Agent panel, canvas, spreadsheet, slides, live preview and i18n.

## License

This directory is GPL-3.0-or-later ([`LICENSE`](LICENSE)), because the app links Zed's GPL-3.0-or-later crates (editor, search, Vim, workspace).
`crates/tex` and `compat/` are Apache-2.0 ([`LICENSE-APACHE`](LICENSE-APACHE)).
Everything outside `gpui/`, the Tauri app and the backend crate the two apps will share included, stays Apache-2.0 ([`../LICENSE`](../LICENSE)); Apache-2.0 code can be part of this GPL work, not the other way round, so nothing under `gpui/` may be copied out of it into the Apache-2.0 tree.

## Running it

```sh
cd gpui
script/fetch-pdfium                      # PDFium chromium/8125, SHA-256 checked, into vendor/
cargo run --release -- path/to/project   # opens main.tex (or the .tex with \documentclass)
```

Requirements:

- Rust 1.99.1 (`rust-toolchain.toml`; Zed at the pinned revision asks for 1.98.1).
- A TeX distribution with `latexmk` (MacTeX, TeX Live, MiKTeX or TinyTeX); it is found the way Lattice finds it, so a GUI launch without `/Library/TeX/texbin` on `PATH` still works.
- macOS: the Command Line Tools are enough, because GPUI compiles its Metal shaders at run time (`runtime_shaders`).
- Windows: MSVC, and `script/fetch-pdfium.ps1` for `pdfium.dll`. MiKTeX's `latexmk` needs Perl.

The first build fetches Zed at the pinned revision and compiles about 1,200 crates, with 3–5 GB of build output.

| Shortcut | Action |
|---|---|
| ⌘O / Ctrl+O | Open a project folder |
| ⌘B / Ctrl+B | Save edited files and build |
| ⌘S / Ctrl+S | Save |
| ⌘F / Ctrl+F | Find in the current file (Zed's search bar: regex, case, whole word, replace) |
| Zed's default keymap | Everything else in the editor |

"Vim mode" in an editor's ⋯ menu turns Zed's Vim mode on for every editor; `LATTICE_GPUI_VIM=1` starts with it on.

## CI

`.github/workflows/gpui.yml` runs only when `gpui/**`, the workflow itself, one of the design-system exports `crates/lattice-ui` generates from changes (`../design-system/tokens.json`, `../design-system/code-themes.json` and what that is generated from; the workflow lists them), or the scene staging the parity report uses (`../design-system/screens/`).
Its `code-themes` job fails while `code-themes.json` is stale (`node design-system/code-themes.mjs --check`).
On macOS and Windows it builds the app (release profile), runs the unit tests (including the latexmk test that is ignored by default) and the `e2e` scenario on `fixtures/e2e`; on macOS it then writes the parity report (below), which does not fail the job.
macOS builds with TeX Live; Windows builds with MiKTeX, and a second Windows job runs the TeX tests against TeX Live.
The Chinese input method (Microsoft Pinyin on Windows) and MiKTeX's own package-install prompts are checked by hand; CI cannot drive them.

## How it is put together

```
crates/lattice-gpui   the app: shell (titlebar + dock), file tree, editor panel,
                      PDF panel (PDFium on its own thread), build panel,
                      LaTeX language, scripted scenarios (macOS, Windows)
crates/lattice-ui     Lattice's look: design tokens generated from
                      ../design-system/tokens.json, the palette, GPUI Kit and
                      Zed editor themes, fonts, type roles, motion, elevation,
                      icons, components and the dock's skin
crates/tex            TeX discovery, latexmk runs, log diagnostics (from ../src-tauri)
compat/gpui-pre       four shims that put GPUI Kit on Zed's GPUI
fixtures/e2e          the project the e2e scenario runs on (copy it first)
experiments/          how to run the same app on gpui-fast
```

### One GPUI for Zed's editor and GPUI Kit

GPUI Kit 0.9.1 depends on the `gpui-pre` 0.3.12 snapshot, which is Zed's GPUI at commit `d2a4fb6ded7c470be25d1541281da3882495b65b`.
The workspace pins Zed's crates (the editor, search, Vim, settings, themes, GPUI) at that same commit.
Cargo would still build two GPUIs, because the packages have different names, so the shims in `compat/gpui-pre` carry the snapshot names and version and re-export Zed's crates, and `[patch.crates-io]` swaps them in.
`Cargo.lock` is seeded from Zed's own lockfile at that commit, and Zed's `[patch.crates-io]` entries are repeated in the workspace manifest because a dependency's patches do not apply.

### Lattice's look

The app draws what the Tauri app draws: the parity target is the running app as Paper's App screens page records it, with `design-system/tokens.json` (exported from Paper) as the source of every value.

- `crates/lattice-ui/src/tokens/` is generated from the JSON, and from `design-system/code-themes.json` for the code themes; a test fails while they disagree. After a Paper export, or after `node design-system/code-themes.mjs` re-exports the Tauri app's code themes, regenerate with `LATTICE_UI_WRITE_TOKENS=1 cargo test -p lattice-ui generated_tokens`.
- `Palette` resolves every colour role for an appearance, tint and accent preset the way `src/styles/theme.css` derives them; GPUI Kit and Zed's editor are themed from it (`kit.rs`, `editor_theme/`, one Zed theme per Lattice code theme), so their own components start in Lattice's colours.
- The dock keeps GPUI Kit's behaviour and wears Lattice's skin (`dock.rs`): rounded panel cards on the chrome, 40px strips of pill tabs, no dividers.
- Fonts: Inter, Ioskeley Mono and Instrument Serif are bundled (`script/make-fonts` writes them). The private Timeless faces are embedded at build time by `crates/lattice-ui/build.rs` when `LATTICE_PRIVATE_FONTS_DIR` (default `~/Downloads/Timeless-Type-Family-1.094`, empty for none) holds the complete download, as the Tauri build embeds them; `LATTICE_PRIVATE_FONTS_REQUIRED=1` fails the build without them. The download's `LICENSE.pdf` is embedded, unmodified, with them (`lattice_ui::fonts::font_license()`); a download without it counts as incomplete, so the faces are not embedded. The app never reads them at run time, and they are never committed.
- `LATTICE_APPEARANCE=light|dark` fixes the appearance instead of following the system's.
- Components (`lattice-ui/src/components/`) follow Paper's Components boards; hover and press fade on the motion tiers (`interaction.rs`). `lattice-gpui --gallery` draws them all on one sheet (`LATTICE_GALLERY_PAGE=2` for the overlays and surfaces) and, with `LATTICE_SHOT_OUT` and `--features offscreen-shots`, saves it.

### The LaTeX language

`crates/lattice-gpui/languages/latex` holds the language config and a highlight query written for this prototype against the latex-lsp tree-sitter grammar (`codebook-tree-sitter-latex`, MIT).
Zed's community LaTeX extension was not used: it carries no license.

### The PDF preview

PDFium (through `pdfium-render`) runs on a dedicated thread, because neither PDFium nor its documents may cross threads.
The PDF is read into memory on every (re)load, so latexmk can rewrite it while it is shown, and Windows does not refuse the write.
Pages are laid out from their sizes at once and drawn only near the viewport; images two pages beyond the visible ones are released from memory and from the GPU atlas.

### The build

`crates/tex` runs `latexmk -cd -outdir=. -auxdir=. -pv- -pvc- -interaction=nonstopmode -synctex=1 -file-line-error -f -pdf|-pdfxe|-pdflua`, like Lattice, with `max_print_line=10000`.
The engine follows a `% !TEX program =` comment or a CJK/fontspec package; with a `latexmkrc` or `.latexmkrc` beside the document it is only a default (`-e '$pdf_mode ||= N;'`), so the rc file's engine wins.
The log parser is Lattice's `parse_diagnostics`, without Lattice's translated advice.

## Scripted runs

```sh
cp -R fixtures/e2e /tmp/lattice-gpui-e2e        # the scenario edits and builds its project
target/release/lattice-gpui /tmp/lattice-gpui-e2e --scenario e2e --out e2e.json
```

`e2e` runs on macOS and Windows; `perf`, `memory`, `ime`, `ime-protocol`, `shot` and `parity` are macOS only.

- `e2e`: opens a project, builds, types a broken macro with native key events, saves with ⌘S / Ctrl+S, builds, follows the error to its line, searches, checks Vim's `x`, repairs and rebuilds, and drags an editor tab into the right dock with native mouse events.
  It needs `chapters/intro.tex` in the project.
- `perf`: Lattice's perf-lab `longTex` scenario: open `long.tex`, fling 200 wheel events of 120 px 8 ms apart with a per-frame meter, click a line, type with 110 ms between keys, then read `footprint`.
- `memory`: `footprint` after opening the project, after opening `long.tex`, and after scrolling through the whole PDF.
- `ime`: selects a Pinyin input method for the window and types `nihao` + space with native key events.
- `ime-protocol`: makes the `NSTextInputClient` calls an input method makes (marked text per keystroke, then the commit) directly on the view.
- `shot`: waits for the project's PDF to draw, then saves the window as `LATTICE_SHOT_OUT` (a PNG), for side-by-side look reviews against Paper's App screens. Built with `--features offscreen-shots` it draws and reads the frame back itself, so the screen may be locked; otherwise it uses `screencapture`, which needs the window on an unlocked screen.
- `parity`: the parity harness's half of a scene (below): the pointer parked, the PDF shown and the build chip staged as a clean 1.2 s build; then it saves the window as `LATTICE_SHOT_OUT` and lists every named region's bounds and label text style in the result.

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
- The GPUI side is `--scenario parity` on a copy of the tutorial project. Both apps show the tutorial's PDF as the web demo ships it (`../tools/web-demo/content/compiled/main.pdf`); `--build-pdf` builds it with latexmk instead.
- The regions are listed per screen in `parity/regions.mjs`, as a selector in the Tauri app's DOM; this app records the same names with `lattice_ui::parity` probes (the components take `.parity(name)`). The probes are not even added to the tree outside a parity run.
- Checks, per screen and theme: each region's bounds within ±1 px; each label's family, size (after the face's `size-adjust`), weight and line height; each chrome region's ground colour within ΔE2000 1; and the share of pixels that differ visibly (ΔE2000 > 2.3) outside text, the PDF pages and what changed between two runs of the same app, within three times that run-to-run noise (at least 0.1%).
- It writes `report.md` (and `index.html`, `report.json`), and per screen and theme a side-by-side image (reference, GPUI, heatmap) and the full-resolution heatmap; the captures are under `runs/`. It exits 0 once the report is written; `--strict` exits 1 when a check fails.

CI's macos job writes the report after the e2e scenario and uploads it as the `gpui-parity-macos` artifact; it does not fail the job yet. The runner's screen shrinks the window to about 1015 px wide, so CI compares the two apps at that width. Only the Main window is ported so far; the other App screens follow in `parity/regions.mjs`.

## Reference projects

Checked on 2026-11-11 before reusing anything.
Only GPUI Kit, Zed's crates, pdfium-render and the LaTeX grammar are dependencies; code was copied only from Lattice (`crates/tex`, see its `NOTICE`).

| Project | License | GPUI it pins | Used here |
|---|---|---|---|
| [GPUI Kit](https://github.com/longbridge/gpui-kit) 0.9.1 | Apache-2.0 | `gpui-pre =0.3.12` (Zed `d2a4fb6`) | dependency: dock, tree, buttons, theme |
| [Zed](https://github.com/zed-industries/zed) `d2a4fb6` | GPL-3.0-or-later (editor, search, Vim, workspace, project); Apache-2.0 (GPUI) | in-tree `gpui` 0.2.2 | dependency: GPUI, editor, search, Vim |
| [gpui-fast](https://github.com/longbridge/gpui-fast) `bbf6dea` | Apache-2.0 (modified fork of Zed's GPUI) | tracks Zed `d2a4fb6` | optional swap-in, tried and working: `experiments/gpui-fast.md` |
| [Ely GPUI Components](https://github.com/ELY-Open-Source/Ely-GPUI-Components) | MIT | `gpui-pre =0.3.11` (Zed `f816e1f`) | not needed: nothing was missing from GPUI Kit |
| [pdf-reader](https://github.com/joelfickson/pdf-reader) | MIT | `gpui =0.2.2` | reference for the PDFium approach (BGRA bitmaps into `RenderImage`) |
| [kkpdf-zed](https://github.com/kk376/kkpdf-zed) | Apache-2.0 OR GPL-3.0-or-later | none (engine only) | reference |
| [zorite](https://github.com/packetThrower/zorite) / `gpui-pdf` | GPL-3.0-or-later (app), MIT (`gpui-pdf`, `ratex-gpui`) | `gpui-pre` 0.3.9 (Zed `93d7456`) | reference (pure-Rust hayro renderer, the alternative to PDFium) |
| [Glim](https://github.com/glimapp/glim) | MIT | `gpui-kit =0.7.1` → `gpui-pre` 0.3.8, vendored | reference (PDFKit overlay, macOS only) |
| [quiet-md](https://github.com/s1dashu/quiet-md) | MIT | `gpui` 0.2.2, vendored | reference for later (rich-text editing) |
| [pdfium-render](https://crates.io/crates/pdfium-render) 0.9.5 | MIT OR Apache-2.0 | none | dependency |
| [PDFium binaries](https://github.com/bblanchon/pdfium-binaries) chromium/8125 | BSD-3-Clause and bundled notices | none | downloaded by `script/fetch-pdfium` |
| [tree-sitter-latex](https://github.com/latex-lsp/tree-sitter-latex) (`codebook-tree-sitter-latex` 0.6.1) | MIT | none | dependency |
| Lattice v0.16.13 (`../src-tauri`) | Apache-2.0 | none | code adapted into `crates/tex` |

tldraw is not used.

