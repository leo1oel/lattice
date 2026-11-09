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
 "source": {"name": "scheme.reactio", "data": "<base64>"},
 "outputs": [{"name": "scheme.pdf", "data": "<base64>"}, {"name": "scheme.tex", "data": "<base64>"}],
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

Each file is `{"name": "scheme.pdf", "data": "<base64>"}`. A paste is untrusted
input, since any web page can put this on the clipboard, so a manifest never
names a path on disk. `source` must be a drawing format or `.svg`, `outputs` are `.tex`,
`.pdf`, `.pdf_tex`, `.png`, `.jpg`, `.svg` or `.eps`, `entry` is a `.tex`, and
all the files together are at most 64 MB. A paste carries at most 32 files,
no two with the same name (case aside), and each name holds only letters,
digits, spaces, `.`, `_` and `-`.

`preamble` is added without asking only if it holds nothing but definitions at
its top level: `\providecommand`, `\newcommand`, `\DeclareMathOperator`,
`\NewDocumentCommand` and `\ProvideDocumentCommand`, each naming one command
and followed by exactly its own arguments; `\definecolor`, `\newcounter` and
`\usepackage` with plain names and no options; and `\makeatletter` or
`\ExplSyntaxOn` around them. A name with `@` counts only after
`\makeatletter`, as TeX reads it. Anything else, a brace group of its own or
`\DeclareRobustCommand` (which silently replaces a command the document has)
included, is shown first and added only on a yes.
The entry file is compiled as it is, like any other project file.

## What Lattice does on paste

Pasting into a LaTeX source (`import_editable_figure`,
`src-tauri/src/project/editable_figure.rs`; the editor side is
`src/editor/insert/editable-figure.ts` and `src/app/editable-figure-paste.ts`):

1. creates the source and the outputs in `figures/`, never over anything and
   never through a link. Files named after the entry move together to the next
   free name (`scheme-2.*`) and any other file finds a free name of its own;
   the entry file's references to its siblings are renamed with them;
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
`.drawio`, `.dio`, `.ipe`, `.excalidraw`, `.ggb`, `.odg`) open directly. An
`.svg` opens only after Lattice asks, every time, since its default program is
often a browser that runs any script in it. Any other file is only revealed in
the file manager.

## For authors of drawing tools

Any program can offer this without talking to Lattice:

1. **Copy.** Put on the clipboard `text/html` holding one element with a
   `data-editable-figure` attribute, the manifest as JSON, and `text/plain` with
   the text that includes the figure, for other editors (the include line, or a
   whole `figure` around it).
2. **Manifest.** `version` is `1`; `name` is informational; `source` is the
   file the figure is edited in; `outputs` are the files rendered from it, the
   `.tex` named by `entry` among them; `packages` are the LaTeX packages it
   needs. A file is `{"name": "scheme.pdf", "data": "<base64>"}`, always
   inline: Lattice does not read paths from a clipboard.
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
