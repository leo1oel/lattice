# Editable external figures

A drawing program can hand Lattice a figure together with the file it was
drawn from, so the figure can be edited again later. Inkscape's PDF+LaTeX
export (`.pdf_tex`) is the model: a PDF of the drawing and a `.tex` file that
includes it and sets text over it in the document's own fonts.

## The clipboard

The program copies two kinds of data:

- `text/html`: an element with a `data-editable-figure` attribute whose value
  is the manifest below, as JSON. A webview's paste event sees only the
  standard types, and a web page can only write text, HTML and images, so the
  manifest travels inside HTML.
- `text/plain`: the line that includes the figure, for editors that do not
  read the manifest, e.g. `\input{figures/scheme}`.

```html
<div data-editable-figure="{&quot;version&quot;:1, …}">\input{figures/scheme}</div>
```

## The manifest, version 1

```json
{"version": 1,
 "name": "scheme",
 "source": {"path": "/Users/me/paper/scheme.reactio"},
 "outputs": [{"path": "/Users/me/paper/scheme.pdf"}, {"path": "/Users/me/paper/scheme.tex"}],
 "entry": "scheme.tex",
 "packages": ["graphicx", "tikz", "chemnum"]}
```

| Field | Meaning |
| --- | --- |
| `version` | `1`. A paste with another version is left to the plain-text fallback. |
| `name` | A short name for the figure (informational). |
| `source` | The file the figure is edited in. |
| `outputs` | The files rendered from it; one of them is `entry`. |
| `entry` | The file name, among `outputs`, that a document includes. |
| `packages` | LaTeX packages the entry needs. |
| `preamble` | Optional. Whole lines the entry needs before `\begin{document}`, added once, unless the document or a file its preamble loads already defines their commands. |

Each file is either `{"path": "<absolute path>"}`, for programs that write
files, or `{"name": "scheme.pdf", "data": "<base64>"}`, for those that cannot
(a web page).

## What Lattice does on paste

Pasting into a LaTeX source (`import_editable_figure`,
`src-tauri/src/project/editable_figure.rs`; the editor side is
`src/editor/insert/editable-figure.ts` and `src/app/editable-figure-paste.ts`):

1. copies the source and the outputs into `figures/`. When any of their names
   is taken there, the whole set moves to the next free name (`scheme-2.*`)
   and the entry file's references to its siblings are renamed with it;
2. replaces the selection with `\input{figures/scheme}`, from the project root.
   On an empty line outside any float it inserts a whole `figure` around that
   line, with empty `\caption{}` and `\label{fig:}` to fill in with Tab;
3. adds to the preamble of a root document what it lacks: the manifest's
   packages, `graphicx`, and `\graphicspath{{figures/}}`, or `{figures/}` in
   an existing `\graphicspath`, so the entry's own
   `\includegraphics{scheme.pdf}` is found. In any other file it names those
   lines in a notice. A name already taken in the project root moves the set to
   a free name as well, since LaTeX looks there first.

The pasted files are ordinary project files: the project builds without the
drawing program, for co-authors and on Overleaf.

## Remembering the source

The entry file's first line names the file it was made from, relative to the
entry:

```latex
% editable-figure source: scheme.reactio
```

## Opening the drawing

Cmd+double-click (Ctrl+double-click on Windows and Linux) on a figure in the
PDF opens its source file in the program the system has for it. Reverse SyncTeX
finds the entry file and its first line names the source; a plain double-click
stays the jump to the source line. The same gesture works on a source line that
includes the figure (`\input`, `\include`, `\import`, `\subimport`). In the
project tree, double-clicking a drawing opens it, and the context menu of a
figure's `.tex` or `.pdf` has Edit figure source. The file must be inside the project.

A project may come from someone else and its `.tex` names the file, so what
opens depends on its type. Drawing formats (`.reactio`, `.cdxml`, `.cdx`,
`.svg`, `.drawio`, `.dio`, `.ipe`, `.excalidraw`, `.ggb`, `.odg`) open directly.
Programs, scripts and web pages (`.app`, `.exe`, `.sh`, `.command`, `.py`,
`.js`, `.html`…) and files with no extension never open. Any other type asks
first, once per extension in a session.

## Inkscape and draw.io drawings

Figures can also be kept as a `.svg` (Inkscape) or a `.drawio`/`.dio` (draw.io)
drawing in the project. **Use as editable figure** in the project tree's context
menu renders it with the program installed in its usual place, writes an entry
`.tex` beside it, with the usual first line, and puts the figure in the LaTeX
editor last in use. Draw.io gives a PDF; Inkscape gives a PDF and a `.pdf_tex`
that sets the drawing's text in the document's fonts.

A drawing file copied in the file manager and pasted into a LaTeX source, or
dropped on it, goes the same way, copied under `figures/` first if it is
outside the project.

A draw.io file of several pages uses the first; the entry's second line,
`% editable-figure page: 1 (of 3: …)`, names them, and changing its number chooses another.

From then on, when the drawing changes on disk and an entry beside it names it,
Lattice renders it again and the watcher rebuilds the document. Only those two
programs run, from their standard locations: a project cannot name one. Without
the program a notice says to install it.

## For authors of drawing tools

Any program can offer this without talking to Lattice:

1. **Copy.** Put on the clipboard `text/html` holding one element with a
   `data-editable-figure` attribute, the manifest as JSON, and `text/plain` with
   the text that includes the figure, for other editors (the include line, or a
   whole `figure` around it).
2. **Manifest.** `version` is `1`; `name` is informational; `source` is the
   file the figure is edited in; `outputs` are the files rendered from it, the
   `.tex` named by `entry` among them; `packages` are the LaTeX packages it
   needs. A file is `{"path": "<absolute path>"}` if your program writes files,
   or `{"name": "scheme.pdf", "data": "<base64>"}` if it cannot.
3. **Name the source.** Make the first line of the entry file
   `% editable-figure source: scheme.reactio`, relative to the entry. This is
   what Cmd/Ctrl+double-click reads; give the source file one of the drawing
   formats above so it opens without asking.
4. **Update on save.** When the source is saved, write the outputs again
   beside it under the same names. Lattice watches the project and rebuilds on
   its own. Only overwrite an entry whose first line names that source.

```json
{"version": 1,
 "name": "scheme",
 "source": {"name": "scheme.reactio", "data": "eyJhdG9tcyI6W119"},
 "outputs": [{"name": "scheme.pdf", "data": "JVBERi0xLjQ="},
             {"name": "scheme.tex", "data": "JSBlZGl0YWJsZS1maWd1cmUgc291cmNlOiBzY2hlbWUucmVhY3Rpbwo="}],
 "entry": "scheme.tex",
 "packages": ["graphicx"]}
```
