# lattice-gpui

A hands-on GPUI prototype of Lattice's core LaTeX writing flow, built to be tried and compared against the current Tauri app.
It is a local experiment: Lattice itself is not touched, and nothing here is published.

What it does, and nothing more:

1. Opens a LaTeX project folder, with the file tree on the left.
2. Edits sources in Zed's editor with LaTeX highlighting, search (Zed's buffer search bar) and an optional Vim mode (Zed's Vim).
3. Shows the PDF on the right, rendered natively by PDFium.
4. Builds with latexmk on one click (or ⌘B / Ctrl+B), reloads the PDF in place, and lists errors that jump to their line.
5. Puts every panel in GPUI Kit's dock: tabs drag between the center and the docks, docks resize and collapse.

Out of scope: the visual Markdown editor, Overleaf, the papers library, the Agent panel, canvas, spreadsheet, slides, live preview and i18n.

## Running it

```sh
script/fetch-pdfium                      # PDFium chromium/8125, SHA-256 checked, into vendor/
cargo run --release -- path/to/project   # opens main.tex (or the .tex with \documentclass)
```

Requirements:

- Rust 1.99.1 (`rust-toolchain.toml`; Zed at the pinned revision asks for 1.98.1).
- A TeX distribution with `latexmk` (MacTeX, TeX Live, MiKTeX or TinyTeX); it is found the way Lattice finds it, so a GUI launch without `/Library/TeX/texbin` on `PATH` still works.
- macOS: the Command Line Tools are enough, because GPUI compiles its Metal shaders at run time (`runtime_shaders`).
- Windows: MSVC, and `script/fetch-pdfium.ps1` for `pdfium.dll`.
  The Windows build is type-checked from macOS (`script/check-windows`) but has not been built or run on Windows.

| Shortcut | Action |
|---|---|
| ⌘O / Ctrl+O | Open a project folder |
| ⌘B / Ctrl+B | Save edited files and build |
| ⌘S / Ctrl+S | Save |
| ⌘F | Find in the current file (Zed's search bar: regex, case, whole word, replace) |
| Zed's default keymap | Everything else in the editor |

The toolbar's "Vim" button turns Zed's Vim mode on for every editor; `LATTICE_GPUI_VIM=1` starts with it on.

## How it is put together

```
crates/lattice-gpui   the app: shell (toolbar + dock), file tree, editor panel,
                      PDF panel (PDFium on its own thread), build panel,
                      LaTeX language, scripted scenarios (macOS)
crates/tex            TeX discovery, latexmk runs, log diagnostics (from Lattice)
compat/gpui-pre       four shims that put GPUI Kit on Zed's GPUI
patches/gpui_macos    Zed's gpui_macos with one lab-only switch
experiments/          how to run the same app on gpui-fast
```

### One GPUI for Zed's editor and GPUI Kit

GPUI Kit 0.9.1 depends on the `gpui-pre` 0.3.12 snapshot, which is Zed's GPUI at commit `d2a4fb6ded7c470be25d1541281da3882495b65b`.
The workspace pins Zed's crates (the editor, search, Vim, settings, themes, GPUI) at that same commit.
Cargo would still build two GPUIs, because the packages have different names, so the shims in `compat/gpui-pre` carry the snapshot names and version and re-export Zed's crates, and `[patch.crates-io]` swaps them in.
`Cargo.lock` is seeded from Zed's own lockfile at that commit, and Zed's `[patch.crates-io]` entries are repeated in the workspace manifest because a dependency's patches do not apply.
The full write-up of this, the first question the prototype had to answer, is in the firstmate home under `data/lattice-gpui-prototype/spike.md`.

### The LaTeX language

`crates/lattice-gpui/languages/latex` holds the language config and a highlight query written for this prototype against the latex-lsp tree-sitter grammar (`codebook-tree-sitter-latex`, MIT).
Zed's community LaTeX extension was not used: it carries no license.

### The PDF preview

PDFium (through `pdfium-render`) runs on a dedicated thread, because neither PDFium nor its documents may cross threads.
The PDF is read into memory on every (re)load, so latexmk can rewrite it while it is shown, and Windows does not refuse the write.
Pages are laid out from their sizes at once and drawn only near the viewport; images two pages beyond the visible ones are released from memory and from the GPU atlas.

### The build

`crates/tex` runs `latexmk -cd -outdir=. -auxdir=. -pv- -pvc- -interaction=nonstopmode -synctex=1 -file-line-error -f -pdf|-pdfxe|-pdflua`, like Lattice, with `max_print_line=10000`.
The engine follows a `% !TEX program =` comment or a CJK/fontspec package.
The log parser is Lattice's `parse_diagnostics`, without Lattice's translated advice.

## Scripted runs (macOS)

```sh
target/release/lattice-gpui PROJECT --scenario e2e|perf|memory|ime|ime-protocol --out RESULT.json
```

- `e2e`: opens a project, builds, types a broken macro with native key events, saves with ⌘S, builds, follows the error to its line, searches, checks Vim's `x`, repairs and rebuilds, and drags an editor tab into the right dock with native mouse events.
  It needs `chapters/intro.tex` in the project.
- `perf`: Lattice's perf-lab `longTex` scenario: open `long.tex`, fling 200 wheel events of 120 px 8 ms apart with a per-frame meter, click a line, type with 110 ms between keys, then read `footprint`.
- `memory`: `footprint` after opening the project, after opening `long.tex`, and after scrolling through the whole PDF.
- `ime`: selects a Pinyin input method for the window and types `nihao` + space with native key events.
- `ime-protocol`: makes the `NSTextInputClient` calls an input method makes (marked text per keystroke, then the commit) directly on the view.

Input is sent the way Lattice's perf lab sends it (`src-tauri/src/perf_lab.rs`): `NSEvent`s through `-[NSWindow sendEvent:]`.
Set `GPUI_LAB_IGNORE_OCCLUSION=1` for measurements: like Lattice's lab, which measures WebKit in windows never composited on the console screen, the window then renders at full rate when nothing of it is visible.
See `patches/gpui_macos/PATCH.md`.

## Reference projects

Checked on 2026-11-11 before reusing anything.
Only GPUI Kit, Zed's crates, pdfium-render and the LaTeX grammar are dependencies; code was copied only from Lattice (`crates/tex`, see its `NOTICE`) and Zed (`patches/gpui_macos`).

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
| Lattice v0.16.13 (`projects/lattice`) | Apache-2.0 | none | code adapted into `crates/tex` |

tldraw is not used.

## License

The app links GPL-3.0-or-later crates from Zed, so the prototype as a whole is GPL-3.0-or-later (`LICENSE-GPL`).
`crates/tex`, `compat/` and `patches/` are Apache-2.0 (`LICENSE-APACHE`; `patches/gpui_macos/LICENSE-APACHE` for Zed's copyright).
