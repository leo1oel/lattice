# Lattice visual Markdown editor: behavioral specification

This is the clean-room specification of Lattice's visual Markdown editor: what
it must do, stated as inputs, outputs, saved bytes and user-visible behavior.
It is the only input the rebuilt editor engine (`src/editor/markdown/engine/`)
is written from. Part I records how the specification was made and how the
engine meets it today; Part II is the specification itself.

## Part I: provenance, engine, and status

### Provenance (clean-room rules)

The vendored Open Knowledge editor (GPL-3.0-or-later) is being replaced by a
Lattice-owned engine so that Lattice can move to a permissive license. The
legal question is whether protected expression was copied, so this document
and the engine are kept separate from the vendored code by procedure:

- **Allowed sources for this specification, and only these:**
  - Lattice's own tests: `src/editor/markdown/*.test.*`, the Markdown cases in
    `src/canvas/document-canvas.test.tsx`, `src/canvas/canvas-toolbar.test.tsx`
    and `src/App.test.tsx`. A test file whose header says it tests code
    adapted from Open Knowledge is excluded (today that is
    `visual-wiki-link-suggestion.test.tsx`).
  - Observed black-box behavior of the current app: an input document, a user
    action, and the saved output.
  - Saved-file formats: the paper converter
    (`src-tauri/src/papers/markdown.rs`) for the formats it writes, the
    tutorial template (`src-tauri/templates/tutorial/notes.md`), and Lattice's
    own Markdown documents.
  - Lattice docs and UX, and the English message catalog
    (`src/locales/en/messages.po`) and the zh-CN catalog for labels a test
    pins in Chinese.
  - CommonMark 0.31 and GFM.
- **Not read:** anything under `src/open-knowledge-app/` or
  `src/open-knowledge-core/`; every Lattice file whose header says it was
  adapted from Open Knowledge or maps onto its extensions
  (`suggestion-popup.tsx`, `visual-editor-block-controls.ts`,
  `visual-link-hover.tsx`, `visual-paper-citation-suggestion.tsx`,
  `visual-source-dirty-observer.ts`, `visual-wiki-link-suggestion.tsx` and its
  test, `visual-link-insert-popover.tsx`, `visual-slash-items.ts`,
  `visual-markdown-schema.ts`); the vendored stylesheet; the vendoring script
  and log (`scripts/vendor-open-knowledge.mjs`,
  `docs/open-knowledge-updates.md`); and the upstream repository. The current
  editor's implementation modules (for example
  `visual-markdown-serialization.ts` and `visual-source-map.ts`) are not cited
  as evidence either: a requirement rests on a test, a document, a saved
  format, or observed behavior.
- **Not evidenced** marks a statement no allowed source supports. It is kept
  only as an open question for the new engine, never as a requirement the
  engine was written from.
- **Not copied into requirements:** upstream identifiers, class names, file or
  module names, and comments. Tests that query vendored DOM hooks are
  restated as user-observable behavior.
- **Every requirement names its evidence** on a `Derived from:` line (see
  Conventions below).
- **The engine is written from this document** plus CommonMark 0.31 and GFM.
  Its files carry the header "Clean implementation for Lattice; spec:
  docs/visual-editor-spec.md". It uses only permissive building blocks:
  Tiptap/ProseMirror (MIT) for editing, and unified, remark, micromark and
  mdast-util-to-markdown (MIT) for Markdown.

### Rebuild scope

Everything Lattice uses today is kept: callouts, accordions, images, math,
Mermaid, footnotes, wiki links, citations, tables with spans, and code blocks,
plus the paper figures the converter writes (R-BLK-15) because paper reading
uses them. Features Lattice does not use are dropped, and any file that
contains them keeps them as byte-preserved raw blocks: Tabs,
Mirror/MirrorSource, the Align block, the Toggle alias, the HTML live-preview
starter, the Video/Audio/Pdf/Embed/File renderers, the generic component
property panel with icon and color pickers, and `%%` comment styling. These
are tagged `[DROP→RAW]` below.

### Engine design

**Opening a file.**

1. *Envelope.* A leading BOM is set aside. A file whose line endings are all
   CRLF is read as LF and written back as CRLF. A file that mixes line endings
   is declined (see "Deliberate differences").
2. *Frontmatter.* A leading `---`/`+++` block (closed by the same delimiter,
   or `...` for YAML) becomes one raw frontmatter block.
3. *Blocks.* The rest is parsed with remark (CommonMark + GFM + `$` math).
   Every top-level node becomes one block with its exact source slice, and the
   exact bytes between blocks are kept too. A PascalCase MDX component and
   everything up to its matching closing tag form a single block.
4. *Invariant.* Leading bytes, blocks, gaps and trailing bytes re-concatenate
   to the file byte for byte; if they ever do not, the file is declined.

**Nodes.** Each block becomes one ProseMirror node:

- A modelled node records its content *and* the style it was written in:
  bullet character, ordered delimiter and numbering, setext or ATX heading,
  fence character and length, thematic-break markup, hard-break markup,
  emphasis and strong markers, and autolink style.
- A text run whose Markdown differs from its text (escapes such as `\_`,
  character references such as `&copy;`, the `\(`…`\)` delimiters) carries
  its authored spelling in a mark. Soft line breaks are nodes of their own, so
  the author's line structure is shown and kept.
- The kept rich blocks are modelled nodes: Callout, Accordion and the paper
  figure components (their bodies read as Markdown), footnote references and
  definitions, `$…$` and `\(…\)` math, display math, tables with merged
  cells (from a layout comment, or inferred in paper reading mode), and HTML
  `<img>` as an image.
- Whatever the engine does not model is kept as verbatim source instead of
  approximated: a *raw block* (other HTML, other MDX components, link
  definitions, frontmatter, and any construct not modelled) or a *raw inline*
  atom (other inline HTML, reference links). A raw block's text *is* its
  Markdown, so editing it edits the file. A converter anchor line
  (`<a id="…"></a>`) is a raw block that renders as an invisible scroll target
  carrying that `id`.

**Saving.** The document is compared with the baseline: the blocks of the
last accepted text, with their source bytes and gaps.

- A node that still equals its baseline node is written from its original
  bytes. Alignment runs over the common prefix and suffix, then over node
  identity and a short structural look-ahead, so an untouched block keeps its
  bytes even after blocks are inserted, deleted or moved elsewhere.
- The gap between two untouched neighbors is kept. A gap next to changed
  content keeps its authored bytes only when it already holds a blank line;
  otherwise it becomes one blank line, so a rewritten block never merges into
  its neighbor.
- Runs of changed nodes are serialized in *literal* style: recorded markers
  and fences, unchanged text runs from their authored spelling, and new text
  unescaped. The result is re-parsed and compared with what the editor shows,
  ignoring style. If it would read back differently, the run is written in
  *safe* style instead, which escapes everything the grammar could misread.
- Every new join (next to a changed run, or between untouched blocks that a
  deletion or an emptied block made neighbors) is re-parsed as a two-block window. If the two
  blocks would read back merged (two lists becoming one, an indented code
  block continuing a list item), the untouched side joins the changed run and
  is re-serialized with it, so the serializer keeps them apart. Only the
  windows around changes are re-parsed, never the whole document.
- The re-parse becomes the new baseline, so successive edits chain.

**Editor.** `lattice-visual-editor.tsx` takes the same props as the vendored
editor (`visual-editor-props.ts`), so the canvas can mount either. It keeps
the host contract:

- compare-and-swap publication, debounced by the shared Markdown sync policy;
- a synchronous flush for ownership hand-off;
- a flush on unmount and on path switch, through the old file's publisher;
- host-owned undo and redo;
- canonical text applied without an undo step or a publication;
- rebasing of a rejected draft;
- the existing conflict notification when a rebase is refused.

Mod-click opens links through Lattice's link routing. Images load through the
project image host, and formulas render with KaTeX using the project's
macros. The stylesheet is new and written from Lattice's design tokens under a
`lx-md-` prefix.

**Enabling it.** The engine sits behind the `visualEditorEngine` setting
(`"ok"` | `"lattice"`, default `"ok"`). It is stored in `localStorage` under
`lattice.visual-editor-engine.v1` and has no UI yet. The engine is a separate
lazy chunk, loaded only when the setting selects it. Setting the key to
`lattice` and reopening the document switches engines.

### Deliberate differences from current behavior

- **More blocks keep their bytes (R-RT-5).** Inserting or deleting a
  top-level block does not rewrite the other blocks. Untouched blocks keep
  their bytes, except a neighbor that would otherwise merge across the new
  join (R-RT-3), which is re-serialized with the changed run.
- **Documents stay editable around unmappable syntax (R-ELIG-5).** Unmappable
  constructs no longer lock the whole document to source mode. They become raw
  blocks, and the rest stays editable.
- **Mixed line endings are declined (R-RT-7).** A file that mixes LF and CRLF
  is shown read-only with the unavailable notice instead of being normalized
  to CRLF on the first write. Only source mode may change a file's line
  endings.

### Status: what the engine meets today (phase 2, first part)

Phase 2 ships in three parts: rich blocks (this state), editor chrome, and
the integration behind engine-agnostic interfaces.

| Area | Met now | Still to come |
| --- | --- | --- |
| Round trip, envelope (R-RT, R-ELIG) | Byte-exact untouched documents; untouched blocks, gaps, BOM, CRLF, trailing newlines and frontmatter preserved on edit; authored syntax inside edited paragraphs kept (R-RT-12 fixtures); escaped new text; nothing written on open; `\(`…`\)` and `\[`…`\]` as math (R-RT-21); explicit and paper-inferred table spans (R-RT-23, R-FMT-13); components, legacy callout fences and footnotes kept byte for byte until edited | — |
| Publication (R-PUB) | R-PUB-1–18, 21 and 22; the host-level R-PUB-19–20 are unchanged host code | — |
| Blocks (R-BLK) | Paragraphs, headings, lists and task lists, quotes, thematic breaks; Callout and Accordion with their properties (R-BLK-1, 2); images with alignment, resizing and zoom (R-BLK-3); display math (R-BLK-4); Mermaid previews (R-BLK-5); footnotes (R-BLK-6); code blocks with their chrome (R-BLK-7); tables with handles, merge and split (R-BLK-11); paper figures (R-BLK-15); unknown components as source (R-BLK-16) | Section rail (R-BLK-13); generated paper Contents (R-BLK-14); task-list input rules and list movement (R-BLK-19); table drag reorder |
| Inline (R-INL) | Marks, links (Mod-click), inline math with its formula field and `$…$` input rule (R-INL-2), images, footnote references, hard and soft breaks, raw inline source | Wiki-link and citation suggestions and chips (R-INL-6, 7), link popover and hover (R-CHR-4) |
| Chrome, source mapping, performance (R-CHR, R-SRC, R-PERF) | Accessible textbox surface; per-keystroke plugin work limited to the blocks an edit touched | Slash menu, selection toolbar, find and replace, block controls and drag, emoji (R-CHR-1–7); frozen table headers (R-CHR-9); carets, comments, tracked changes, view in source (R-SRC); passive viewport (R-PERF-1–6) |

**Tests.**

- `src/editor/markdown/engine/markdown-corpus.test.ts` holds the corpus:
  Lattice's own Markdown (README, CONTRIBUTING, the notices, `docs/`, the
  tutorial template, the embedded skills) and every saved-file format in §11,
  as byte-exact fixtures in `engine/fixtures/lattice-formats.json`. Each
  document must:
  - reproduce itself byte for byte when untouched;
  - read back as shown when every block is rewritten;
  - change only the edited block under random single-block edits
    (fast-check).
- `markdown-document.test.ts` pins the core rules, including every R-RT-12
  fixture under an edit; `rich-blocks.test.ts` pins how each rich block is
  read and written.
- `lattice-visual-editor.test.tsx` pins the host contract, and
  `lattice-visual-blocks.test.tsx` drives every rich block through the editor.
- `differential.test.tsx` runs the same corpus through the vendored editor
  and the engine. The vendored editor is mounted only as a black box through
  the shared props contract. For every document the engine must open what the
  old editor opens as editable, write it back byte for byte, publish nothing
  on open, and show the same headings, code and formulas. The harness goes
  with the vendored editor in phase 3.

### Phase 2 derivation notes

Where a requirement leaves a choice open, the engine makes the one recorded
here, with the requirement it rests on.

- **Components (R-BLK-1, R-BLK-2, R-BLK-15, R-FMT-2, R-FMT-5).** Only the
  keep list is modelled: Callout, Accordion, PaperFigure, PaperFigureRow and
  PaperFigurePanel. A component whose properties include an expression other
  than a string, number, `true` or `false` stays source, and so does any tag
  the reader cannot fully account for. The body between the tags is read as
  Markdown. The opening tag keeps its bytes while its properties are
  unchanged, and the body keeps its bytes while its meaning is unchanged. An
  edited body keeps the authored whitespace next to the tags, and a new
  component gets blank lines (the R-FMT-2 form). Callout types map to five
  tones: note (also info and default), tip (success), important, warning,
  caution (danger, error). Each component edits only its own fields: a
  Callout its title, tone and whether it collapses; an Accordion its title and
  whether it starts open.
- **Legacy callout fences (R-FMT-6).** Once edited, a fence is written as
  `<Callout …>`, a blank line, the `content`, a blank line, and `</Callout>`.
  The spec does not pin the layout; this is the new-component form.
- **LaTeX delimiters (R-RT-21).** `\(`…`\)` is a micromark construct that
  claims its span before emphasis is read, so underscores in TeX never pair
  across formulas. `\[`…`\]` on one line is a formula only as a whole
  paragraph with no `\]` before its end (the case R-RT-21 pins), so
  `\[1\] Smith, see also \[2\]` stays prose. As a construct inside prose it
  would turn escaped brackets such as `a\[i\]` into math. A multi-line `\[` … `\]` is
  joined across the paragraphs and setext headings CommonMark reads it as, as
  long as no blank line intervenes.
- **Formula editing (R-INL-2, R-BLK-4, R-FMT-12).** The inline field commits
  on Enter, and Escape cancels. A display formula is an atom whose selection
  offers only its properties and delete. Its multi-line field adds lines on
  Enter and commits on Mod-Enter. Both fields also commit when the reader
  clicks away. An edit never changes the kind of formula the author wrote.
  An edited inline formula (`$…$` or `\(…\)`) is written `$…$`. A formula
  shown as display math is saved as display math. That includes a
  whole-paragraph `\[…\]` on one line. When the new TeX still reads back in
  the formula's own delimiters, they are kept: `\[…\]` stays `\[…\]` and
  `$$…$$` stays `$$…$$`. A single-line `\[…\]` fits only if the TeX has no
  line break and no `\]`. When the TeX does not fit, the formula is written in
  the canonical display form, `$$…$$`, and never as `$…$`.
- **Paper span inference (R-BLK-11), from its fixtures.** A table infers
  nothing unless it has a second header level: a row that repeats a label
  directly above it. Within the header levels, each repeated label must fill
  an exact rectangle, which becomes one span. Any other shape makes the whole
  table ambiguous, and nothing merges. Below the header, repeats down the
  first column merge. Serialization writes no layout comment for spans that
  inference would read back.
- **Explicit layouts (R-BLK-11, R-FMT-10, R-FMT-11).** A layout is also
  invalid when a covered cell does not repeat its origin's text; saving would
  otherwise overwrite that cell. A merge of distinct values joins them in
  reading order with a space. Splitting leaves an explicit layout of the
  remaining spans. In paper reading mode that is `{"spans":[]}` when none
  remain; elsewhere the empty layout is dropped.
- **Table edits (R-FMT-22, §11.14).** Nothing is inserted above or deleted
  from the header row, because GFM needs exactly one. Columns are inserted
  and deleted only in tables without merged cells, and the alignment row
  follows them. A written table pads cells with one space and uses `---`
  delimiters, so an edited cell rewrites its own row.
- **Images (R-BLK-3, R-FMT-7).** An HTML `<img>` is modelled only when its
  attributes are among `src`, `alt`, `title`, `width` and `align`; anything
  else stays source. Center alignment is the default and is written only when
  it was authored.
- **Footnotes (R-BLK-6).** A reference shows its label. Notes are numbered in
  the order the document first refers to them; notes never referred to follow
  in document order.
- **Mermaid (R-BLK-5).** Only a fence of exactly three backticks on both
  sides with the language `mermaid` renders. The diagram follows the app
  theme. Dragging a preview edge resizes it symmetrically, and the new
  `w=<n>px` is written when the drag ends.
- **Code blocks (R-FMT-8, R-BLK-7).** A picked language is written as its
  canonical token (`python`, `typescript`, `text`). A title commits on Enter
  or when its popover closes. Tab indents by two spaces, and Mod-Enter leaves
  the block.
- **Unknown components (R-BLK-16).** The nested source editor is the block's
  own editable text, not a separate editor: editing writes back and remote
  changes reconcile silently, as required. A dropped component such as Embed
  may show an unsafe URL as source text, but never gives it to the DOM as a
  link or source (R-BLK-18).
- **Loading and IME (R-PUB-8, R-PUB-10, R-PUB-18).** A file switch or
  canonical text applies on a microtask, outside React's commit. A switch
  keeps the surface busy and read-only until the new file is shown. The Enter
  that commits an IME candidate is ignored for 50 ms after
  `compositionend`.

---

## Part II: requirements

### 0. Conventions

- **IDs.** `R-<GROUP>-<n>`. Groups: RT (round trip / envelope), ELIG (eligibility and source-mode
  fallback), PUB (publication, undo, file switching, IME, conflicts), FMT (saved-file formats the
  editor writes on specific actions), BLK (block nodes and rich blocks), INL (inline marks, links,
  math), CHR (chrome), SRC (source mapping), PERF (virtualization and large documents).
- **Fixtures.** A fenced block tagged `json` holds **JSON string literals**, so `\n`, `\r\n`,
  `\uFEFF`, `\\` and `\"` are escapes and the fixture is byte-exact. A fenced block tagged `text` or
  `markdown` holds **raw bytes** (the file content itself, with a final newline only if shown by a
  following blank line inside the block — treat those as illustrative unless the requirement says
  "exact").
- **Edit notation.** `in → edit → out` means: open `in`, perform the edit, and the next saved
  (published) document is exactly `out`.
- **Keep / drop tags.** `[KEEP]` = in the rebuild's keep list (callouts, accordions, images, math,
  Mermaid, footnotes, wiki links, citations, tables with spans, code blocks). `[DROP→RAW]` = the
  new engine renders it as a raw-preserved block (bytes kept exactly, no rich UI). Untagged =
  plain Markdown or editor infrastructure.
- **"Derived from".** `path:line "test name"` for tests (line = the line holding the test name);
  `path:line-line` for Lattice docs, the tutorial template, and the paper converter's saved formats. Test names that mention the upstream project by
  name are elided with "…".
- **"Current behavior" notes** mark observed Lattice behavior that the new engine may improve on
  but must not regress below.

---

### 1. RT: round-trip and the file envelope

**R-RT-1: Opening never writes.** Opening, rendering, or re-rendering a document the user has not
edited must never publish a change. This covers converter output, frontmatter, BOM and CRLF files,
MDX components, legacy fences, unknown components, and bare converter ordinals.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1068 "keeps a BOM and final-newline envelope pristine and writes one exact CAS update on edit"`;
`…:2550 "keeps converter Markdown editable and byte-identical: %s"`;
`…:1874 "edits canonical MDX component content visually and preserves its source until changed"`;
`…:1988 "preserves legacy component fences and migrates them only after a visual edit"`;
`…:2044 "edits a source-preserved block through the nested source editor and reconciles remote edits into it"`;
`…:2559 "renders bare paper ordinals as one continuous list without visible escapes"`;
`…:423 "keeps large read-only documents virtual until the complete surface is requested"`.

**R-RT-2: Untouched blocks keep their source bytes.** When the user edits a document, every
top-level block whose content did not change is written back with its **original source bytes**.
Only the edited blocks go through canonical serialization. A document with no changed block is
written back byte-identical.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2575 "re-serializes only the edited block and leaves tight boundaries alone"`;
`…:2550 "keeps converter Markdown editable and byte-identical: %s"` (nothing is rewritten when nothing changed);
`src/editor/markdown/visual-markdown-block-model.test.ts:5 "owns exact block slices while preserving every gap and envelope byte"`.
```json
in:   "## Contents\n- 1 Introduction\n\nClosing prose.\n"
edit: append "!" to "Closing prose."
out:  "## Contents\n- 1 Introduction\n\nClosing prose.!\n"
```

**R-RT-3: Inter-block gaps.** The whitespace between two adjacent blocks comes from the source
when **both** blocks are unchanged. A gap next to an edited block holds at least one blank line,
so a rewritten block is never spliced tight onto its neighbor, and the two blocks on either side
of a new join must read back as the same two blocks. Leading bytes before the first block and
trailing bytes after the last block come from the source.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2575` (the tight `## Contents`/list boundary
survives because both sides are untouched); `src/editor/markdown/visual-markdown-block-model.test.ts:5`
(leading bytes, gaps and trailing bytes are exact source); `src/editor/markdown/markdown-collab.test.ts:51 "preserves BOM, CRLF, and all trailing blank lines"`;
CommonMark 0.31 §4.8 and §5.2–5.3 (without a blank line, a following line can continue a
paragraph or a list item, so only a blank line keeps arbitrary blocks apart).

**R-RT-4: What counts as "unchanged".** A block is unchanged when it is structurally identical to
its parse from the last accepted text: same node type, attributes and content. A heading whose
level changed counts as changed even though its text did not. A block moved away from its
original neighbors is not spliced back into its old position.
*Not evidenced:* finer equivalences (for example a hard break against a literal newline, or
whether a deleted inline atom is compared as content) are not pinned by any allowed source. The
new engine treats every content difference as a change.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2510 "does not restore %s"` (cases "an
ordinally shifted block after a non-adjacent move": `"A\n\nB\n\nC\n"`→`"B\n\nC\n\nA\n"`, and "a
changed heading level with unchanged text": `"## Title\n"`→`"### Title\n"`. Both yield the
serializer output, not spliced source).

**R-RT-5: Splice only under exact ownership.** Source bytes may be spliced back only when the
mapping from source to blocks is **exact**. Exact means: one source root per rendered top-level
block, in order, non-overlapping, and each source slice rendering exactly one block. The top-level
block count must also be the same before and after. Otherwise the whole document is written in
canonical form. Content must never be duplicated or moved by a best-effort mapping. A zero-block
node (YAML, a link definition, a footnote definition) that cancels out a paragraph expanding into
two blocks does not count as exact.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2494 "keeps unmappable Markdown source-only and never splices best-effort ranges into it"`;
`src/editor/markdown/visual-source-map.test.ts:18 "checks the rendered block count on every call"`,
`:25 "keeps rejecting ambiguous documents once their blocks are memoized"`,
`:9 "answers for the text it is given, not the previous answer"`;
`src/editor/markdown/visual-markdown-block-model.test.ts:31 "refuses source shapes whose root ownership is not exact"`
(a footnote definition followed by an indented paragraph).
*Not evidenced:* no allowed source pins what the current editor writes for the other blocks after
a top-level block is inserted or deleted. Rich blocks survive verbatim either way (R-RT-15). The
new engine may preserve more, but not less.

**R-RT-6: BOM envelope.** A leading U+FEFF is envelope, not content. It is preserved on every
write. Source offsets used for mapping are body-relative, with a base of 1 when a BOM is present.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1068 "keeps a BOM and final-newline envelope pristine and writes one exact CAS update on edit"`;
`src/editor/markdown/visual-markdown-block-model.test.ts:5 "owns exact block slices while preserving every gap and envelope byte"`.
```json
in:   "\uFEFFHello\n"
edit: insert " world" after "Hello"
out:  "\uFEFFHello world\n"
```

**R-RT-7: Line-ending envelope.** When the original body contains any CRLF, every newline in the
written document is CRLF. Otherwise it is LF.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1061 "reports Markdown when the rendered paragraph is directly edited, keeping CRLF and a final newline: %j"`;
`src/editor/markdown/markdown-collab.test.ts:51 "preserves BOM, CRLF, and all trailing blank lines"`.
```json
in:   "Hello\r\n"      edit: replace paragraph text with "Changed"   out: "Changed\r\n"
in:   "Hello"          edit: same                                     out: "Changed"
```
*Not evidenced:* no allowed source pins how a file that mixes LF and CRLF is written. The new
engine declines to edit such a file (see "Deliberate differences"), so no line ending changes.

**R-RT-8: Trailing-newline envelope.** The written document ends with exactly the original run of
trailing newlines: none, one, or several blank lines. It never ends with the serializer's own.
Derived from: `src/editor/markdown/markdown-collab.test.ts:51 "preserves BOM, CRLF, and all trailing blank lines"`;
`src/editor/markdown/visual-markdown-editor.test.tsx:1061`, `:903`.
```json
serialized body: "Changed\n"
original:        "\uFEFFOriginal\r\n\r\n"
written:         "\uFEFFChanged\r\n\r\n"
```

**R-RT-9: Frontmatter is envelope.** A leading YAML frontmatter block is preserved byte-exact. It
is never rendered as editable prose, and it survives visual edits, including a replacement of the
entire visible body. Frontmatter never shifts block mapping. Anchored comments that fall inside it
are not shown in the visual view.
Derived from: `src/App.test.tsx:1763 "opens relative project files from Markdown previews"`;
`src/editor/markdown/visual-markdown-editor.test.tsx:2550` (case "frontmatter");
`src/canvas/document-canvas.test.tsx:278 "maps secondary Markdown comments around frontmatter and wires live threads and creation"`.
```json
in:   "---\ntitle: Exact metadata\n---\n[Native unified view](native-unified-view.md)\n\n-\n  [ ] Review preview"
edit: replace the whole visual body with "[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview"
out:  "---\ntitle: Exact metadata\n---\n[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview"
then: click the task checkbox → out contains "- [x] Review preview"
```

**R-RT-10: No unauthored trailing paragraph.** A document ending in a table, list, or code block
keeps that block last. The editor must not append an empty paragraph that would be saved.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:295 "does not append an unauthored paragraph after a final %s"`.
```json
in: "| A | B |\n| --- | --- |\n| C | D |\n"   edit: type "X" before "A"        out: "| XA | B |\n| --- | --- |\n| C | D |\n"
in: "- Item\n"                               edit: type "X" before "Item"     out: "- XItem\n"
in: "```text\nExample\n```\n"                edit: type "X" before "Example"  out: "```text\nXExample\n```\n"
```

**R-RT-11: Authored trailing blank line.** A single authored blank line after the last block is
kept as an editable empty paragraph. It serializes back to the same bytes and does not grow.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1964 "keeps an authored single trailing blank line editable without growing it"`.
```json
in: "- Item\n\n"   serialized unchanged: "- Item\n\n"
```

**R-RT-12: Byte preservation of syntax next to an edit.** Each fixture below stays editable.
After typing `Updated ` at the start of the first paragraph, the output is exactly
`"Updated " + in`. This holds when the syntax sits in a *different* block, and also when the
source-sensitive inline syntax (fixtures k and l) sits *inside the edited paragraph*.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2455 "preserves %s exactly when nearby prose changes"` (labels at 2439-2454).
```json
a four-backtick fence around backticks:   "Editable\n\n````text\n```\n````"
a tilde fence around backticks:           "Editable\n\n~~~text\n```\n~~~"
a mixed-case tilde Mermaid fence:         "Editable\n\n~~~~MerMaid\ngraph TD; A-->B\n~~~~~"
a metadata-bearing Mermaid fence:         "Editable\n\n````mermaid title=flow\ngraph TD; A-->B\n`````"
reference links:                          "Editable paragraph\n\nRead [Results][paper].\n\n[paper]: results.md \"Title\""
inline HTML:                              "Editable paragraph\n\nPress <kbd class=\"key\">&copy;</kbd> now."
raw-text HTML:                            "Editable paragraph\n\nCode <script>a && b</script> after."
an HTML entity:                           "Editable paragraph\n\nCopyright &copy; 2026."
block HTML:                               "Editable paragraph\n\n<aside data-kind=\"note\">Exact HTML</aside>"
standalone inline HTML (not its own block): "Editable\n\nBefore\n<kbd>Ctrl</kbd>\nAfter"
(k) source-sensitive image syntax:        "Before ![Plot](<../figures/my plot.png> \"Results\") after"
(l) LaTeX escapes in untouched inline math: "Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$ here."
LaTeX math delimiters in untouched blocks: "Intro paragraph.\n\n\\[\nE=mc^2\n\\]\n\nInline \\(x_i\\) math."
LaTeX-delimited inline math:              "Editable\n\nThe result is \\(x^2\\)."
LaTeX-delimited display math:             "Editable\n\n\\[\nx^2 + y^2\n\\]"
```

**R-RT-13: Math, fence casing, and footnote whitespace survive nearby edits.** After editing the
first paragraph of the fixture below, the output still contains `$x + y$`, the fence
` ```MerMaid\ngraph TD; A-->B\n``` ` with its casing, and `[^note]: Keep  two spaces` with its
double space.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2463 "preserves math, Mermaid fences, and raw blocks when nearby prose changes"`.
```json
"Editable paragraph\n\nThe value is $x + y$.\n\n```MerMaid\ngraph TD; A-->B\n```\n\n[^note]: Keep  two spaces"
```

**R-RT-14: Converter anchors are lossless.** A converter anchor line `<a id="…"></a>` is invisible
in visual mode, works as a scroll target, and round-trips exactly. The whole document below
serializes to itself.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:852 "keeps converter anchors invisible and lossless in visual mode"`.
```json
"<a id=\"S3.F1\"></a>\n\n![Figure](paper_assets/figure.png)\n\n*Figure 1: Model overview.*\n\nSee Figure [1](#S3.F1).\n"
```

**R-RT-15: Rich blocks survive structural edits verbatim.** Adding a block with the block "+"
action in the tutorial document keeps several constructs byte-identical in the output: every
fenced code body with its info string (three fences, including `python title="…"`,
`mermaid title="…"` and `html preview h=360px title="…"`), the `<Callout …>…</Callout>` and
`<Accordion …>…</Accordion>` blocks, and the `<img … width={223} />` line.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1215 "keeps tutorial fenced-code bodies when the block plus action adds a slash paragraph"`;
`src-tauri/templates/tutorial/notes.md:23-31,80-123`.

**R-RT-16: Inline image syntax round-trips.** `![alt](src "title")` inside a paragraph survives an
edit of that paragraph.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2478 "round-trips Markdown images instead of dropping them on the first edit"`.
```json
in:  "Before ![Plot](figures/plot.png \"Results\") after"
out: contains "![Plot](figures/plot.png \"Results\")"
```

**R-RT-17: Unknown components are byte-preserved.** An unregistered JSX/MDX component is
isolated as a raw source block, and its exact bytes survive edits elsewhere. Adjacent unknown
components (paired, with attributes, self-closing) and the bytes after them round-trip exactly,
even while their deferred conversion is running.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2063 "isolates unsupported blocks while keeping the surrounding document editable"`;
`src/editor/markdown/jsx-auto-convert-safety.test.tsx:31 "preserves adjacent unknown components and following source as earlier fallbacks expand"`.
```json
round-trips exactly: "<UnknownOne>\nFirst body.\n</UnknownOne>\n\n<UnknownTwo mode=\"wide\">\nSecond body.\n</UnknownTwo>\n\n<UnknownThree />\n\nFollowing bytes stay here.\n"
in:  "Editable paragraph\n\n<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>"
edit: type "Updated " into the paragraph
out: contains "<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>"
```

**R-RT-18: Deferred conversion never resurrects or goes stale.** If an unknown component is
deleted before its deferred conversion runs, it stays deleted. If it is replaced, the replacement's
source is what gets converted.
Derived from: `src/editor/markdown/jsx-auto-convert-safety.test.tsx:80 "does not restore an unknown component removed before its deferred callback"`,
`:66 "converts the replacement's source instead of dispatching a stale fallback"`.
```json
in:   "<Unknown>\nRemove me.\n</Unknown>\n\nFollowing bytes stay here.\n"
edit: delete the first block
out:  "Following bytes stay here.\n"
```

**R-RT-19: Hashtags are prose.** `#word` is plain text. No tag node, no tag suggestions, and no
`\#` escaping is ever written.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2105 "renders and edits research hashtags as ordinary text"`.
```json
in:   "Model statistics: #Params, #Tokens, and #Samples"
edit: type " #anything" at the end
out (trimEnd): "Model statistics: #Params, #Tokens, and #Samples #anything"
```

**R-RT-20: Multi-paragraph footnote definitions round-trip.** A definition with a 4-space-indented
continuation paragraph stays one definition. Editing it keeps the indentation.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2075 "renders multiline Markdown footnote definitions as directly editable nodes"`.
```json
in:   "Evidence[^source].\n\n[^source]: Supporting **result**.\n\n    Second **paragraph**."
edit: insert "Extra " before "Supporting"
out:  contains "[^source]: Extra Supporting **result**.\n\n    Second **paragraph**."
```

**R-RT-21: LaTeX math source round-trips.** LaTeX math delimiters keep their exact source when
untouched:
- `\(…\)` inline;
- multi-line `\[ … \]` display, including a line that is a lone `=`, which must not become a setext
  heading;
- a single-line `\[…\]`, which becomes an inline formula and keeps its bytes;
- several `\(…\)` spans in one paragraph, even when the underscores between them look like emphasis;
- `\[` inside a `latex` code fence, which stays code.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2757 "parses LaTeX display and inline delimiters into math nodes with their exact source"`,
`:2781 "promotes a single-line latex display block and round-trips its bytes"`,
`:2790 "pairs multiple inline latex spans across a misparsed emphasis run"`,
`:2774 "keeps latex delimiters inside code fences as code"`.
```json
"\\[E=mc^2\\]\n"                                                        (round-trips exactly)
"```latex\n\\[\nE=mc^2\n\\]\n```\n"                                     (round-trips exactly; one code block)
"\\(\\mathrm{supp}_{\\mathrm{par}}\\) 问的是「**哪些权重被编辑**」；\\(\\mathrm{supp}_{\\mathrm{tea}}\\) 问的是「**哪些特征被监督**」。\n"  (exact; 2 formulas, bold runs kept)
"Before text.\n\n\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]\n\nAfter \\(f_S^{\\ell}\\) math.\n"  (paragraph, display math, paragraph)
```

**R-RT-22: Single-dollar math inside converted lists.** `$X$`, `$Y$` and `$D/2$` inside list items
whose first line is the converter glyph `•` round-trip. The result is equivalent under the
eligibility canonicalization (R-ELIG-2).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2768 "preserves single-dollar inline math inside converted list prose"`.
```json
"- •\n  No positional information.\n- •\n  One-dimensional embeddings.\n- •\n  Two axes use $X$ and $Y$, each with size $D/2$.\n- •\n  Relative positional embeddings.\n"
```

**R-RT-23: Explicit and inferred table layouts round-trip.** A table with an explicit span-layout
comment, or a paper table whose spans were inferred, serializes back to its exact source followed
by one newline, which the envelope then trims.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2251 "%s and round-trips the exact source"`,
`:2220 "visually merges repeated labels in extracted-paper tables and expands them on save"`.
Fixtures are in R-BLK-11.

**R-RT-24: GFM table edits leave surrounding prose alone.** Editing a table cell must not
normalize neighboring prose. The double space in `Authored  prose` survives.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2195 "renders and edits GFM tables as visual table cells without rewriting surrounding authored source"`.
```json
in:  "Authored  prose\n\n| Left | Right |\n| :--- | ---: |\n| A | B |"
edit: insert "Updated " before "A"
out: starts with "Authored  prose\n\n" and contains "Updated"
```

**R-RT-25: Empty code fences stay empty.** An authored empty fence stays empty after unrelated
structural edits. A deleted code body is never moved into a neighboring empty fence.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1517 "keeps authored and canonical empty fences empty"`,
`:1524 "does not move deleted code into a neighboring empty fence"`,
`:1449 "keeps intentional code clearing authoritative"`.
```json
"```js\n\n```"   stays "```js\n\n```"
in: "```js\nconst value = 1\n```"   edit: select-all code and delete   out starts with "```js\n\n```"
```

**R-RT-26: Bold keeps rendering across equivalent reloads.** Authored bold survives a canonical
re-render of equivalent text (the same text plus a trailing newline) and never shows literal `**`.
Cases: `**nknk**`, `**. nknk**`, `中文 **粗体** 内容`.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1077 "keeps authored bold text visual across a canonical rerender: %s"`.

**R-RT-27: Copied block math keeps its formula.** Copying a display-math block between two editors
keeps its formula, including an unsaved edited formula. The pasted block serializes that formula.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2711 "preserves block-math formulas when copied between visual editors"`.

---

### 2. ELIG: eligibility and source-mode fallback

**R-ELIG-1: Eligibility rule.** The visual surface is editable only when the document **round-trips
exactly**. The check is:
1. parse the text,
2. serialize it,
3. splice untouched blocks back (R-RT-2..5),
4. restore the envelope (R-RT-6..9),
5. compare with the original modulo the allowed equivalences of R-ELIG-2.

Eligibility is a property of the (path, text) pair. It is re-evaluated whenever the text changes.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2516 "reports a lossy paper to its parent without an in-article warning, then clears it once lossless"`;
`…:2494 "keeps unmappable Markdown source-only and never splices best-effort ranges into it"`;
`…:2550 "keeps converter Markdown editable and byte-identical: %s"`.

**R-ELIG-2: Allowed equivalences, and only these.**
1. GFM table formatting: cell padding, delimiter width, and the same alignment written differently
   compare equal when header, alignments and rows are equal.
2. A single trailing space or tab at line end. Two or more trailing spaces are a hard break and
   stay significant.
3. A backslash before `.` in prose (`w\.r.t.` ≡ `w.r.t.`).
4. One structural leading newline that the serializer emits before a table at document start.

Double spaces inside prose are **not** equivalent. Setext headings (`Title\n---`) and
`---` thematic breaks are not tables, including when the would-be header has an escaped `\|`. A
one-column table whose header contains an unescaped pipe **is** a table.
Derived from: `src/editor/markdown/markdown-collab.test.ts:27 "canonicalizes represented GFM table formatting without touching surrounding source"`,
`:36 "treats a harmless escaped prose period as equivalent"`,
`:42 "does not mistake setext headings or thematic breaks for one-column tables"`.
Items 2 and 4 are *not evidenced* by a test; item 2 agrees with CommonMark 0.31 §6.7, where only
two or more trailing spaces make a hard line break.
```json
equal:     "Authored  prose\n\n| A | B |\n| :--- | ---: |\n| x | y |"  vs  "Authored  prose\n\n| A   | B   |\n| :---- | ----: |\n| x   | y   |"
equal:     "Use w.r.t. here."  vs  "Use w\\.r.t. here."
not equal: "Authored prose"    vs  "Authored  prose"
not a table: "Setext heading\n---", "Prose\n\n---\n\nMore", "Escaped \\| pipe\n---"
a table:   "| A |\n| --- |\n| x |"
```

**R-ELIG-3: Converter output must be editable and must not be rewritten on open.** Every fixture
below opens editable. No lossy warning appears, and nothing is published after the fixture has
been open for 50 ms.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2550 "keeps converter Markdown editable and byte-identical: %s"` (labels 2537-2549).
```json
frontmatter:                          "---\ntitle: Example\nauthors: [Ada]\n---\n\nPaper body.\n"
a heading tight against its list:     "## Contents\n- 1 Introduction\n- 2 Approach\n"
a caption tight against its table:    "**Table 1: Caption.**\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"
a paragraph tight against its list:   "Questions we answer:\n1) First\n2) Second\n"
a converter checklist:                "- 1.\nFirst answer\n- 2.\nSecond answer\n"
bare converter ordinals:              "1.\nFirst answer\n2\\.\nSecond answer\n"
a stray asterisk in prose:            "The authors (1* and 2*) contributed equally.\n"
emphasis nested in a bold caption:    "**Table 1: A *single* Flamingo model.**\n"
an indented paragraph after a footnote: "[^n]: First paragraph.\n\n  Not a continuation."
converter-normalized paper math:      "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- •\n  Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$.\n"
LaTeX-delimited math:                 "Before text.\n\n\\[\n\\mathcal{L}_{\\mathrm{tea}}\n=\n\\sum_{k\\in T} w_k\n\\]\n\nAfter \\(f_S^{\\ell}\\) math.\n"
```

**R-ELIG-4: Bare paper ordinals form one list.** Alternating `1.` / `2\.` ordinal lines each
followed by their text render as **one** ordered list of four items. The escape backslashes are
not visible, and nothing is published.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2559 "renders bare paper ordinals as one continuous list without visible escapes"`.
```json
"1.\nConstrained visual capabilities.\n2\\.\nChallenges in efficient training and deployment.\n3.\nMultiple components complicate the scaling analysis.\n4\\.\nLimited image pre-processing flexibility.\n"
```

**R-ELIG-5: Unmappable documents are source-only.** A document is locked to source mode when two
things hold together: its blocks cannot be mapped exactly to source (for example because an HTML
comment carries no position), and canonical serialization would change bytes. In source-only mode:
- the surface is `contenteditable=false`;
- a `status` region shows a **warning-level** (not error-level) message containing "unsupported or
  lossy syntax";
- no splice is attempted, and the canonical text is returned unchanged even when asked twice.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2494 "keeps unmappable Markdown source-only and never splices best-effort ranges into it"`;
comment at `…:238-243`.
```json
in (locked):     "<!-- c -->\n\n[^n]: First paragraph.\n\n  Not a continuation.\n"
canonical form:  "<!-- c -->\n\n[^n]: First paragraph.\n\nNot a continuation.\n"   (loses the two-space indent → lossy)
contrast (editable, R-ELIG-3): "[^n]: First paragraph.\n\n  Not a continuation."
```

**R-ELIG-6: Paper documents report lossiness to the host.** In paper reading mode (a
`.research/papers/<id>/paper.md` path with reading optimization on), a lossy document shows **no**
in-article warning. The editor reports the message to its host, which renders a "Visual editing is
unavailable…" status above the paper's generated title. While locked, the find bar's "Replace
current match" and "Replace all matches" are disabled. When the same path's text becomes lossless,
the warning clears and editing re-enables.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2516 "reports a lossy paper to its parent without an in-article warning, then clears it once lossless"`;
`src/canvas/document-canvas.test.tsx:401 "places a paper's visual editing warning above its generated title"`.

**R-ELIG-7: Parser failures degrade, never crash.** If the raw MDX parse of the whole document
throws, for example on an unclosed `{` from a PDF text layer, the document still opens with all
readable prose. Nothing noisy is logged, and eligibility is still decided by the round trip. A
single block whose parse throws is isolated as a raw source block while its neighbors parse
normally. The recovery is counted in health metrics without flooding the log.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2585 "survives a document whose raw MDX parse throws"`,
`:2601 "records recovered malformed MDX without flooding the application log"`.
```json
"# UNIC quiet fallback\n\nBefore the break.\n\nvalue = {0|150|never closed\n\nAfter the break.\n"
```

**R-ELIG-8: Unsupported constructs are isolated, not document-blocking.** Constructs the editor
cannot render richly do not lock the document:
- unknown components, raw block HTML, inline HTML, entities, reference links and definitions,
  thematic breaks, and tables all leave the rest of the document editable;
- tables never degrade to a raw block;
- unknown components become raw source blocks that keep their bytes (R-RT-17).

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2063`, `:2455`,
`:2486 "keeps thematic breaks and the prose between them visually editable"`, `:2195`.

**R-ELIG-9: No per-document source toggle when editable.** An eligible, editable document shows
no in-editor "Edit Markdown source" escape hatch. Source editing is the host's Edit/Split view.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1061`.

**R-ELIG-10: Read-only is separate from ineligible.** A host-requested read-only document
(`editable=false`) is not a lossy one. It shows no lossy warning, and commenting still works
(R-SRC-9).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:842 "keeps comments available while the visual document is read-only"`, `:423`.

---

### 3. PUB: publication, undo, file switching, IME, conflicts

**R-PUB-1: Compare-and-swap publication.** The editor publishes with `publish(next, expected)`,
where `expected` is the last text the host accepted. The host answers accepted or rejected. After
an accepted publication, `expected` becomes `next`. One edit produces exactly one publication.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1068`,
`:1035 "uses the last accepted Markdown for rapid consecutive visual edits"`.
```json
in: "Start"; the editor content is replaced with "First" and then "Second" in quick succession
published once: next="Second", expected="Start"
```

**R-PUB-2: Deferred, coalesced publication.** Nothing is published synchronously. Rapid edits
coalesce into **one** publication, which lands within 1.0 s outside reading mode and within 1.5 s
in paper reading mode. The document-size policy is:
- idle 200 ms, max 1,500 ms, peer-scroll settle 0 ms for a 1,000-character document;
- idle 1,000 ms, max 5,000 ms, settle 140 ms at or above the large-document threshold.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:903 "coalesces rapid edits into one deferred publication %s, and flushes a pending edit on unmount"`,
`:315 "uses one adaptive synchronization policy for every Markdown preview"`.
```json
in: "Hello"; insert " a", " b", " c" rapidly → one publish: next="Hello a b c", expected="Hello"
```

**R-PUB-3: Flush on unmount.** Unmounting the editor, for example on a mode or tab switch,
publishes any pending edit immediately and synchronously.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:903` (then " final" +
unmount → `("Hello a b c final", "Hello a b c")`).

**R-PUB-4: Ownership hand-off (flush).** The editor registers a synchronous flush callback with its
host. Calling it publishes the pending edit and returns whether the document is safe to hand over.
On unmount the editor deregisters the callback (the registration becomes `null`).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:948 "lets the file-transition owner flush an edit before changing paths"`.

**R-PUB-5: IME blocks the hand-off.** During an IME composition the flush returns `false`. It
also returns `false` for the rest of the event turn after `compositionend`, because WebKit can
deliver the committing Enter right after compositionend. After that it returns `true`.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:961 "does not hand document ownership away during an IME composition"`.

**R-PUB-6: A rejected draft blocks the hand-off once.** When the host rejects a flush publication,
that flush returns `false`, because a draft now exists and is being preserved. The next flush
returns `true`.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:975 "allows ownership changes after a rejected draft has been preserved"`.

**R-PUB-7: Path switch publishes against the old file.** When the active path changes with a
pending edit, the edit is published through the **previous** file's publisher, against the
previous file's text, before the new file loads.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:985 "publishes a pending edit for the previous file when the path switches"`.
```json
a.md "Alpha" + " edit" → switch to b.md "Beta" → exactly one publish: {path:"a.md", next:"Alpha edit", expected:"Alpha"}
```

**R-PUB-8: File switching reuses one editor, and undo cannot cross files.** Switching files reuses
the same editor instance. During the swap the view is `aria-busy="true"` and non-editable. The new
text replaces the old completely. Undo (Mod-z) is delegated to the host: the editor's internal
history must never restore the previous file's content.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:920 "reuses the TipTap instance when switching files and does not let Undo restore the previous file"`.

**R-PUB-9: Swaps reload even when the text is the same.** Switching to a file whose text equals the
current prop text still reloads from that text and drops the local edit shown for the previous
file. Cancelling a scheduled swap by switching back before it completes restores the retained
editor, editable and with the right content.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1003 "swaps files that share identical body text"`,
`:1014 "restores the retained editor when a scheduled file swap is cancelled"`.

**R-PUB-10: Swap loading state.** A file swap shows no visible "Opening document…" text. Any
loading indicator is `aria-hidden`. Rich blocks, such as an image, are constructed without framework
lifecycle warnings.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1025 "constructs file-switch NodeViews outside React lifecycle methods"`.

**R-PUB-11: History belongs to the host.** Mod-z calls the host's undo and Mod-Shift-z its redo.
The editor never undoes locally. Replacing the document from canonical text, such as an external
update or a file load, is not an undoable step and emits no update.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1086 "does not report an external text update and delegates history to the canonical document"`, `:920`.

**R-PUB-12: External updates are applied silently.** When the host changes the canonical text
(another pane, an agent, a file poll), the editor adopts it without publishing, without a lossy
warning, and without a conflict notice. That still holds when the editor had an internal
non-authored normalization pending.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1086`,
`:1113 "accepts an agent edit without mistaking passive editor normalization for a draft"`;
`src/App.test.tsx:3047 "accepts an agent edit in an open Markdown preview and still switches files"`.
```json
in: "## Scope\n- **Measures**: Initial result\n"
external: "## Scope\n- **Measures**: Agent revision\n"
→ displayed; no publication; no notification
```

**R-PUB-13: Internal normalization is not an edit.** After mount, the view may normalize parsed
multi-line text into hard-break nodes. That normalization is neither published nor treated as a
draft.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1113 "accepts an agent edit without mistaking passive editor normalization for a draft"`.

**R-PUB-14: Minimal patches in UTF-16.** The local and remote changes are each computed as one
minimal replacement: a common prefix, a common suffix, and the replaced middle, with offsets in
UTF-16 code units, including around astral characters.
Derived from: `src/editor/markdown/markdown-collab.test.ts:10 "produces a minimal replacement in UTF-16 offsets, around astral characters too"`.
```json
("alpha beta omega", "alpha BETA omega") → {from:6, to:10, insert:"BETA"}
("😀 alpha omega",   "😀 ALPHA omega")   → {from:3, to:8,  insert:"ALPHA"}
```

**R-PUB-15: Rebase a rejected draft over a disjoint remote edit.** When the host rejects a
publication and a new canonical text arrives, the editor rebases its draft:
- disjoint edits merge;
- adjacent, non-empty replacements merge;
- overlapping edits refuse;
- two insertions at the same boundary refuse.

A successful rebase is published against the new canonical text, with no alert.
Derived from: `src/editor/markdown/markdown-collab.test.ts:23 "rebases (or refuses) %s"`;
`src/editor/markdown/visual-markdown-editor.test.tsx:1102 "rebases a rejected local draft over a disjoint remote edit without dropping either"`.
```json
base / draft / canonical → result
"alpha beta omega" / "ALPHA beta omega" / "alpha beta OMEGA" → "ALPHA beta OMEGA"
"abcd" / "aBcd" / "abcD" → "aBcD"
"😀 alpha omega" / "😀 ALPHA omega" / "😀 alpha OMEGA" → "😀 ALPHA OMEGA"
"alpha beta" / "alpha local" / "alpha remote" → refuse
"ab" / "aLocalb" / "aRemoteb" → refuse
editor: "Alpha middle Omega" + " tail" (rejected); remote "Prefix Alpha middle Omega"
→ publish next="Prefix Alpha middle Omega tail", expected="Prefix Alpha middle Omega"
```

**R-PUB-16: Conflict: remote wins, draft kept.** When the rebase refuses, the remote canonical
text is displayed. An app-level error notification (not an in-document bar) appears, titled "This
document changed in the same place", with the body "The shared version is shown. Your visual draft
was kept — copy it, or restore it and try again." The notification does not time out. Its actions:
- **"Copy draft"** writes the complete draft text to the clipboard. It is separate from the
  notification's ordinary copy-error-report action.
- **"Restore draft and retry"** puts the draft back into the editor and retries.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1124 "keeps remote canonical text authoritative and exposes the complete rejected draft"`,
`:1133 "preserves an IME draft across a remote canonical update at compositionend"`;
`src/locales/en/messages.po` (strings from `visual-markdown-editor.tsx`).

**R-PUB-17: A remote update waits for IME to finish.** A canonical update that arrives during an
IME composition is deferred. The composing draft stays visible until `compositionend`, and then
R-PUB-15/16 apply.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1133`.
```json
in: "Original"; compose "完整的本地草稿"; remote "Remote canonical" during composition
→ still shows the draft; at compositionend shows "Remote canonical"; "Restore draft and retry" brings back "完整的本地草稿"
```

**R-PUB-18: IME Enter must not trigger structural shortcuts.** An Enter that commits an IME
candidate must not exit or split a container, whether it arrives before or after
`compositionend`. The same Enter inside a component property field must not close the properties.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1898 "keeps a Callout intact when Chinese IME text is committed by an Enter %s"`,
`:1940 "keeps Callout properties open when Enter commits Chinese IME text %s"`.

**R-PUB-19: Host saving (integration).** Host-level saving behaves as follows:
- When focus leaves the visual editor (to the source pane or any outside input), the latest
  transaction is written immediately, even with manual builds and without waiting for the
  debounce, as a CAS write (`content`, `baseContent`).
- A non-collaborative secondary pane saves on blur and on idle.
- An open visual edit is written before a Paper opens, and is never written into the paper's path.
- An edit made while a Paper read is pending is kept, and the late Paper does not replace it.

Derived from: `src/App.test.tsx:2690 "saves pending visual Markdown when focus moves to %s in manual build mode"`,
`:2721 "saves non-collaborative secondary Markdown on %s in %s mode"`,
`:3943 "publishes the current visual document before opening a Paper"`,
`:3966 "keeps the current document when it is edited during a delayed Paper read"`.
```json
"Original paragraph.\n" + typed "Latest edit. " at start → write {content:"Latest edit. Original paragraph.\n", baseContent:"Original paragraph.\n"}
```

**R-PUB-20: Source and preview coexistence (integration).** Source-pane edits reach the visual
view on an idle budget. An edit the visual view published itself must never be rolled back by an
older source snapshot arriving after it. An external blank-line edit such as
`"# Notes\nParagraph\n"` → `"# Notes\n\nParagraph\n"` is displayed without any write. It survives
the next poll and the next save.
Derived from: `src/App.test.tsx:1763` (lines 1797-1812), `:3066 "preserves an external Markdown blank-line edit through the next save and poll"`,
`:1492 "previews each Markdown pane independently and allows both previews"`.

**R-PUB-21: Adjacent edits do not remount rich views.** An insertion next to an existing
preview (Mermaid, HTML) or loaded image, including the editor's own echo coming back through a
controlled host, must not replace the document from canonical text. Mermaid and HTML previews
stay mounted, and the image is not reloaded.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2851 "keeps existing Mermaid and HTML previews mounted across adjacent inserts and controlled Markdown echoes"`,
`:2918 "keeps a loaded Markdown image visible when the plus action inserts %s it"`.

**R-PUB-22: Chrome acts on the live target.** A component's own delete button acts on the node's
**current** position, not the position it rendered with. The button refuses and does nothing if
the node changed underneath it (for example through a concurrent write); the refusal is counted
in health metrics.
Derived from: `src/editor/markdown/jsx-auto-convert-safety.test.tsx:106 "deletes the component, not the block that now sits at its rendered position"`,
`:122 "refuses a chrome action once its component changed underneath it"`.
```json
in: "<Callout title=\"Target\">\nBody.\n</Callout>\n\nTail stays.\n"; insert paragraph "Inserted" at top; click Callout delete
out: "Inserted\n\nTail stays.\n"
```

---

### 4. FMT: what the editor writes on specific actions

(Catalogue with all syntaxes in §11.)

**R-FMT-1: Toolbar inline formatting.** Applying a mark from the selection toolbar writes:
- Bold → `**…**`
- Italic → `*…*`
- Highlight → `==…==`
- "Convert selection to inline math" → `$…$`

It works for CJK text too.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1594 "serializes %s formatting from the toolbar"`,
`:1639 "updates the mounted selection toolbar when the interface language changes"`.
```json
"Hello" select all → "**Hello**" | "*Hello*" | "==Hello==" | "$Hello$"
"中文格式测试" select first 2 chars → Bold → "**中文**格式测试"
```

**R-FMT-2: Slash Callout.** In an empty document the slash Callout writes exactly:
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1774 "inserts %s"` (label "a canonical MDX callout"); constant at `:236`.
```json
"<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>"
```

**R-FMT-3: Slash Image.** Without an import handler, the slash Image writes an empty image with
no prompt. With one, it opens a file picker, imports through the host, and writes the returned
path relative to the current file. Either way the `/image` query text is removed.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1774` (label "an empty image without prompting, dropping the slash query"),
`:1801 "imports an image through the host project workflow"`.
```json
"<img src=\"\" />"
"<img src=\"figures/uploaded.png\" />"      (active file notes.md, host returned figures/uploaded.png)
```

**R-FMT-4: Links.** Inserting, editing and removing a link writes:
- The slash Link inserts placeholder text `link` with an empty target, selects it, and opens the
  URL field. Choosing Done writes the link.
- Editing an existing link's URL rewrites only the target.
- Remove unlinks, leaving the text.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1864 "opens the URL field when Link is inserted from the slash menu"`,
`:2121 "edits and removes an existing Markdown link in place"`.
```json
"" → slash Link, URL "https://example.com", Done → "[link](https://example.com)"
"[Docs](https://old.example)" → URL "https://new.example", click outside → "[Docs](https://new.example)" → Remove → "Docs"
```

**R-FMT-5: Component property serialization.** A component's string property is written as a
quoted attribute when the value is portable. It becomes a JSX expression string when it contains
characters like `&` or `"`. Editing the body of a component re-serializes its body Markdown.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1874`.
```text
in:  <Callout title="Exact">
     Text with **bold**.
     </Callout>
body edit → contains: Edited Text with **bold**.
title "Changed & quoted "title"" → contains: title={"Changed & quoted \"title\""}
```

**R-FMT-6: Legacy fence migration.** A legacy ` ```rw-component callout ` fence (JSON body) stays
byte-identical until the first visual edit of that block. After that edit it is written as an MDX
`<Callout …>`: JSON keys other than `content` become attributes, the `content` string becomes the
body, and the `rw-component` text disappears.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1988 "preserves legacy component fences and migrates them only after a visual edit"`.
```json
in:   "```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```"
edit: title → "Migrated"
out:  starts "<Callout ", contains "title=\"Migrated\"" and "Kept", not "rw-component"   (exact layout not pinned)
```
*Not evidenced:* which other `rw-component` kinds exist, and what happens to a fence whose body is
not a JSON object, are not pinned by any allowed source. The new engine keeps every such fence as
a byte-preserved block.

**R-FMT-7: Image resize and alignment become an HTML image.** Resizing or aligning a Markdown
image writes an HTML `<img>` element:
- src, alt and title are carried over;
- width is written as an integer JSX expression; height is never written;
- alignment is written as `align="…"`;
- no internal-only attributes (such as a source-URL cache) are written.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2998 "resizes a Markdown image and persists its dimensions as an HTML image"`,
`:2975 "keeps image alignment in the hover toolbar instead of the selection bubble"`.
```text
in:  ![Plot](figures/plot.png "Results")
resize to 400px → contains: width={400}  src="figures/plot.png"  alt="Plot"  title="Results"   (no height=)
in:  ![Plot](figures/plot.png)
align right → contains: align="right"  src="figures/plot.png"   (no sourceUrl=)
```
Attribute order is not pinned. Tutorial and host fixtures use `src`, `alt`, `width`:
`<img src="figures/plot.png" alt="Plot" width={223} />` (`src/App.test.tsx:4198`).

**R-FMT-8: Code fence info string.** Changing the language rewrites only the language token and
keeps `title="…"`. A title edit is committed on Enter (or when editing finishes), never per
keystroke. Deleting the block removes it entirely.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1532 "round-trips code language and title metadata through edits and a canonical rerender"`,
`:2833 "offers Mermaid in the code block language picker"`.
```json
"```ts title=\"Example with spaces\"\nconst answer = 42;\n```"
→ language Python  → "```python title=\"Example with spaces\"\nconst answer = 42;\n```"
→ title "Updated title" + Enter → "```python title=\"Updated title\"\nconst answer = 42;\n```"
→ Delete code block → ""
"```text\ngraph TD; A-->B\n```" → language Mermaid → "```mermaid\ngraph TD; A-->B\n```"
```

**R-FMT-9: HTML preview fence meta `[DROP→RAW]`.** The slash HTML item writes an
` ```html preview ` fence with starter content ("Hello, world!"). Resizing its preview writes
`w=<n>px` and never `h=`. Alignment writes `align=right` (unquoted).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1829 "inserts … HTML starters as sandboxed preview code blocks"`.
*New engine:* the live preview is dropped. The meta tokens (`preview`, `w=`, `h=`, `align=`,
`title=`) must still round-trip byte-exact as part of the info string.

**R-FMT-10: Table span layout marker.** Merge and split write, move, or clear an HTML-comment
layout marker directly above the table (see R-BLK-11 and §11.13):
- merging two header cells → `{"spans":[[0,0,1,2]]}`;
- merging five → `[[0,0,1,5]]`;
- a 2×2 rectangle across the header boundary → `[[0,0,2,2]]`;
- splitting one of two spans keeps the other → `[[0,2,1,2]]`;
- splitting an inferred paper span writes an explicit empty layout, `{"spans":[]}`, so inference
  cannot re-merge it.

The column alignment row (`| :--- | ---: | :---: |`) is preserved.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2307 "merges matching selected cells without duplicating content or losing column alignment"`,
`:2329 "merges five selected cells and preserves every distinct value"`, `:2344 "merges a four-cell rectangle across the header boundary"`,
`:2293 "splits one merged cell without discarding other explicit spans"`, `:2280 "splits an inferred paper cell and persists the explicit unmerged layout"`.

**R-FMT-11: Malformed spans refuse to serialize.** A span that does not fit the table grid makes
serialization fail with "Cannot serialize malformed table spans". It is never silently written.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2272 "refuses to serialize malformed table spans"`.

**R-FMT-12: Edited inline math is canonicalized to dollars.** Committing an edit to an inline
formula writes `$…$`, even when the source used `\(…\)`. An untouched formula keeps its original
delimiters (R-RT-12).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2680 "edits %s"`.
```json
"The result is $x^2$."    → formula "y^3" + Enter → "The result is $y^3$."
"The result is \\(x^2\\)." → formula "y^3" + Enter → "The result is $y^3$."
```

**R-FMT-13: Paper-inferred merged labels expand on save.** Editing a visually merged label in
an inferred paper table writes the edit into **every** source cell the span covers.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2220`.
```text
RADIO_TABLE (R-BLK-11); insert "Updated " before the merged "C-RADIOv4" → output has "| Updated C-RADIOv4 |" exactly twice
```

**R-FMT-14: Task checkboxes.** Toggling a task item writes `- [x]` or `- [ ]`. Typing the
`[X] ` marker records the uppercase `X` so it can be written back as typed.
Derived from: `src/App.test.tsx:1763`; `src/editor/markdown/task-list-input-rule.test.ts:66 "turns typed %j into a task item"`.

**R-FMT-15: List reorder.** Moving list items preserves each item's checkbox state. Ordered lists
are renumbered from the authored start number. Nested siblings reorder within their parent only.
Derived from: `src/editor/markdown/visual-editor-list-movement.test.ts:29,40,49,58`;
`src/editor/markdown/visual-markdown-editor.test.tsx:1299 "targets the hovered list item and publishes its reorder without moving surrounding prose"`.
```json
"Before\n\n- Alpha\n- Bravo longer\n\nAfter"                       → move Bravo up → "Before\n\n- Bravo longer\n- Alpha\n\nAfter"
"Before\n\n- [ ] Alpha\n- [x] Bravo longer\n- [ ] Charlie\n\nAfter" → move Bravo up → "Before\n\n- [x] Bravo longer\n- [ ] Alpha\n- [ ] Charlie\n\nAfter"
"7. Alpha\n8. Bravo longer\n9. Charlie\n10. Delta"                 → move Alpha+Bravo down → "7. Charlie\n8. Alpha\n9. Bravo longer\n10. Delta"
"- Parent\n  - Alpha\n  - Bravo longer\n- Other"                   → move Bravo up → "- Parent\n  - Bravo longer\n  - Alpha\n- Other"
"- Alpha\n- Bravo longer\n- Charlie\n- Delta"                      → drag Alpha+Bravo after Delta → "- Charlie\n- Delta\n- Alpha\n- Bravo longer" → move Delta up → "- Delta\n- Charlie\n- Alpha\n- Bravo longer"
```

**R-FMT-16: Block operations.** A selected block (or table, or atom) is deleted as a unit. A
top-level block moves by keyboard or drag. A moved atom keeps its exact bytes and stays selected.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1423` ("deletes a selected block as one unit",
"moves the current top-level block through the editor transaction", "reorders top-level blocks with the WebKit-safe pointer drag transaction"),
`:1429 "keeps an atomic block selected after moving it"`, `:2357 "deletes a block-selected table instead of clearing its cells"`.
```json
"First\n\nSecond" → delete first → "Second"
"First\n\nSecond" → move Second up → "Second\n\nFirst"
"First\n\nSecond\n\nThird" → drag First after Second → "Second\n\nFirst\n\nThird"
"Before\n\n$$\nx\n$$\n\nAfter" → move math up → "$$\nx\n$$\n\nBefore\n\nAfter"
"Before\n\n| Left | Right |\n| --- | --- |\n| A | B |\n\nAfter" → delete selected table → "Before\n\nAfter"
```

**R-FMT-17: Citations.** Citations write a Markdown link to the paper's local file:
- Accepting a citation suggestion writes `[<title>](<rel>/.research/papers/<arxivId>/paper.md)`
  followed by a space. Papers without full text but with a blog use `blog.md`.
- `<rel>` is the path from the current note, with `../` added for nested notes.
- Dropping a paper from the library writes `[@<citationKey>](…)` at the pointer.
- Deleting the atom removes the whole link.

Derived from: `src/editor/markdown/visual-paper-citation-suggestion.test.tsx:51,69,177,198`.
```json
"Before after" (notes/reading.md), drop paper at pos 8 → "Before [@vaswani2017attention](../.research/papers/1706.03762/paper.md)after"
"Before @attention" Enter, then "after" → "Before [Attention Is All You Need](.research/papers/1706.03762/paper.md) after"
delete atom (Backspace or Delete) → "Before  after"   (two spaces); undo restores the link
```

**R-FMT-18: Wiki links.** Wiki links are written as `[[Doc]]` or `[[Doc#heading-slug]]`, where the
slug is one the workspace index builds for that page's heading.
Derived from: the rebuild's keep list (Part I, "Rebuild scope");
`src/editor/markdown/markdown-workspace-index.test.ts:36,43` (heading slugs).
*Not evidenced:* the bytes a suggestion writes, including for a page that does not exist yet. The
only test of the suggestion menu is excluded (Part I).

**R-FMT-19: Emoji** are written as plain Unicode at the caret, in one publication.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1811 "opens the emoji picker from the slash menu and inserts at the caret"`.

**R-FMT-20: Moving a file rebases relative image paths (host).** When an open Markdown file moves
into a folder, the host rewrites relative `<img src>` paths so they still resolve.
Derived from: `src/App.test.tsx:4198 "rebases image paths when an open Markdown file is moved into a folder"`.
```json
notes.md → figures/notes.md
"# Notes\n\n<img src=\"figures/plot.png\" alt=\"Plot\" width={223} />\n" → "# Notes\n\n<img src=\"plot.png\" alt=\"Plot\" width={223} />\n"
```

**R-FMT-21: Tabs `[DROP→RAW]`.** The slash Tabs item writes `<Tabs>` with two children,
`<Tab label="Tab 1">` and `<Tab label="Tab 2">`.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1783 "inserts Tabs as two nested, visually selectable MDX Tab components"`.

**R-FMT-22: Table row insertion keeps the GFM header.** Inserting a row, from the menu or with
Enter in the last row, keeps the first row as the header row and writes a valid delimiter row.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2367 "shows table controls for a collapsed cell cursor and preserves the GFM header row"`,
`:2411 "uses Enter to move down a table column and appends a row at the bottom"`.
Output matches `/\| Left\s+\| Right\s+\|\n\| -+ \| -+ \|/`.

---

### 5. BLK: block nodes and rich blocks

**R-BLK-1: Callout `[KEEP]`.** `<Callout …>` renders as a callout box with rich Markdown in its
body (for example bold). Its properties (title) are edited in a properties popover, and typing
mid-value keeps the caret position. Closing the properties (Enter) returns the caret to the body,
not a block selection. Other rules:
- a Callout emptied by an edit is repaired to hold one empty paragraph;
- Enter in an empty trailing paragraph stays inside the Callout (it adds a second paragraph rather
  than exiting);
- the Callout has a Delete action (R-PUB-22).

Types seen: `note`, `important`. Attributes seen: `title`, `collapsible={false}`, `defaultOpen`.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1874`, `:1913 "keeps the caret in place while typing a Callout property, then returns to the body when properties close"`,
`:1971 "repairs an empty Callout produced by an editing transaction"`, `:1979 "keeps an empty trailing paragraph inside a Callout on Enter"`;
`src-tauri/templates/tutorial/notes.md:23-25`.

**R-BLK-2: Accordion `[KEEP]`.** `<Accordion title="…" defaultOpen>` renders as an open disclosure
with a clickable summary. Its body holds rich Markdown (a paragraph with bold, a list, a code
block). Content and the open state survive the editor remounting, for example from Preview to
Split.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1246 "keeps accordion block content visible when remounting from Preview to Split"`, `:1215`.

**R-BLK-3: Images `[KEEP]`.** Markdown and HTML images render as images:
- `![alt](src "title")` and `<img src alt width={N} />` both render; `width={N}` renders N px wide.
- Relative sources resolve against the document's folder (`../figures/plot.png` from
  `notes/results.md` → project path `figures/plot.png`) and load through the host asset reader
  with async decoding. With no reader, the displayed src is project-root-absolute
  (`/figures/plot.png`).
- Unsized images show "auto" size; resized images show "authored" size.
- Clicking zooms to larger than the rendered size.
- Alignment controls live in a hover toolbar (default center), not in the selection bubble; the
  image properties panel has no advanced or align section.
- Closing the properties of a final image leaves a gap cursor *after* it, and adds no paragraph.
- Unsafe schemes (`javascript:`, `file:`) never reach the DOM.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2910 "loads %s through the host asset reader"`, `:2478`, `:2953 "expands a Markdown image beyond its rendered editor size"`,
`:2975`, `:2998`, `:1952 "rests after a final image without selecting it when properties close"`, `:2004 "does not let embed or media components load local files or script schemes"`, `:1215`.

**R-BLK-4: Display math `[KEEP]`.** `$$\n…\n$$` and multi-line `\[\n…\n\]` render as KaTeX
display blocks. A display block is an atomic block: selecting it shows properties and delete
controls only, with no separate "edit equation" button. It stays selected after a move.
Rendering happens without an intermediate source placeholder, and LaTeX 2.09 font macros are
supported (`{\sc …}` renders upright, `{\sl …}` slanted).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1429`, `:2757`, `:2643 "renders complete-editor math before any viewport intersection, with LaTeX 2.09 font compatibility macros"`, `:482`.

**R-BLK-5: Mermaid `[KEEP]`.** A ` ```mermaid ` fence is an ordinary fenced code block:
- It shows a rendered diagram preview by default, with the code hidden. A toggle shows and hides
  the code; the text stays in the document either way.
- The source is edited like any code block (R-FMT-8).
- The language picker offers Mermaid.
- `title="…"` renders a title attached to the preview, and `w=320px` sets the preview width.
  Resize handles are on the left and right only.
- The diagram viewport has pan controls (up, down, left, right, 48 px each, eased over 200 ms,
  not animated under reduced motion).
- Fences with nonstandard casing (`MerMaid`), tilde fences, or longer and unbalanced fences stay
  plain, byte-preserved code blocks.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2811 "renders Mermaid as a normal code block with a preview toggle and plain HTML as a default preview"`,
`:2833`, `:2843 "keeps Mermaid source editable as an ordinary fenced code block"`, `:1573 "renders a titled %s block with its title attached to the surface"`, `:2455`, `:2463`;
`src/editor/markdown/mermaid-controls.test.tsx:52 "pans the viewport in the labeled direction (reduced motion: %s)"`.

**R-BLK-6: Footnotes `[KEEP]`.** A reference `[^id]` renders as a link-styled `[id]`. A definition
`[^id]: …` renders as an auto-numbered note that has an anchor and a back-link to its reference.
Definitions, including continuation paragraphs, are directly editable and write back. The
back-link and other trailing footnote chrome are not natively selectable, while the note text is.
The slash menu and the selection toolbar both offer footnote creation: a reference plus a
definition stub, or the selection converted to a footnote.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2075`, `:2463`, `:275 "excludes trailing %s controls from native selection without excluding its content"`, `:1639`,
`:1710 "offers the complete set of Markdown-native insertions and unmounts the open menu cleanly"` (the slash menu offers Footnote).

**R-BLK-7: Code blocks `[KEEP]`.**
- Enter inserts a newline, and repeated Enter at the end keeps adding lines: there is no
  triple-Enter exit.
- A trailing empty line is rendered, and text can be typed on it.
- Highlighted spans never contain newline characters, so WebKit can move the caret.
- Wrapping preserves whitespace.
- The chrome has a language picker that announces the resolved language, a title, a settings
  popover with a title field, Copy (copies exactly the code text), and Delete. There is no AI
  composer.
- Remote cursors on fence lines are not drawn (R-SRC-3).

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1459 "inserts newlines on Enter inside a code block, advancing beyond Tiptap's triple-Enter exit"`,
`:1491 "renders a trailing newline, accepts text on the new line, and keeps line endings outside spans"`, `:1532`, `:1573`.

**R-BLK-8: HTML fences `[DROP→RAW]`.**
- A plain ` ```html ` fence, and an ` ```html preview ` fence, render a sandboxed live preview
  (`sandbox="allow-scripts"`) with the code hidden. The preview's scrollbars stay hidden until
  hover.
- Show and hide toggles are provided.
- The preview can be resized by width only, and resizing preserves the scroll position.
- Alignment is left, center (default) or right.
- A remote cursor inside the code reveals the code while it is there.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1829`, `:2811`, `:552 "reveals preview source while an Overleaf cursor is inside its code"`.
*New engine:* render as a byte-preserved code block (R-FMT-9).

**R-BLK-9: Wiki links `[KEEP]`.** See R-INL-6.

**R-BLK-10: Citations `[KEEP]`.** See R-INL-7.

**R-BLK-11: Tables and spans `[KEEP]`.**
- GFM tables render as editable cells, with header cells for the first row.
- Enter moves down a column, and on the last row appends a new row. With a text selection inside
  a cell, Enter still moves down rather than splitting the cell.
- Row and column handle menus offer items such as "Insert row below" and "Insert column left".
- Merged tables do not offer drag reorder, and column handles anchor to logical grid columns.
- The span controls are "Merge cells" and "Split cell".
- Paper reading mode uses lightweight cell handles instead of frozen headers and insert controls.

Span semantics (all fixtures round-trip exactly):
- An **explicit layout** comment immediately before the table defines spans as
  `[row, col, rowspan, colspan]`. Row 0 is the header row. Body rows count from 1 and skip the
  delimiter row. Columns are 0-based. Every source cell a span covers repeats the origin cell's
  text. The comment is not rendered as content.
- **Paper inference** applies only in paper reading mode on a paper path. Repeated header labels
  and repeated stub labels are inferred as spans. An explicit empty layout suppresses inference.
  Outside paper mode the same table renders flattened with every cell.
- **Not inferred:** repeated data values, ambiguous intersections, single-level duplicate headers,
  and single-stub duplicates.
- An **invalid layout** (a span beyond the grid) is kept as a raw comment block, and the table
  renders unmerged.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2181 "keeps %s editable"`, `:2195`, `:2209 "renders a flattened merged paper table without dropping or shifting columns"`, `:2220`, `:2251`,
`:2260 "round-trips explicit layouts for tables nested in a blockquote"`, `:2390 "anchors handles to logical columns and keeps merged tables out of rectangular drag reorder"`, `:2411`, `:2420 "moves down a column instead of splitting the cell when table text is selected"`,
`:2280`, `:2293`, `:2307`, `:2329`, `:2344` (the layout marker's serialized bytes).
Row shapes below are cells per rendered row.
```json
INFERRED (paper path) — rows [2,1,3], origin colspan 2 rowspan 2:
"| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n| Other | Variant | 2 |"
EXPLICIT (notes.md) — rows [2,3], origin colspan 2:
"<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->\n\n| Group | Group | Metric |\n| --- | --- | --- |\n| A | B | 1 |"
EXPLICIT EMPTY suppresses inference (paper path) — rows [3,3,3]:
"<!-- lattice-table-layout:v1 {\"spans\":[]} -->\n\n| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n| Other | Variant | 2 |"
INVALID layout kept as its own block, table unmerged [2,2]:
"<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,3]]} -->\n\n| A | B |\n| --- | --- |\n| C | D |"
NOT inferred (paper path): "| Run | Status | Flag A | Flag B | Score |\n| --- | --- | --- | --- | --- |\n| A | Passed | Yes | Yes | 1 |\n| B | Passed | No | No | 2 |"  → [5,5,5]
NOT inferred: "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Variant | 1 |" → [3,3]
NOT inferred: "| Run | Score | Score |\n| --- | --- | --- |\n| A | 1 | 2 |" → [3,3]
NOT inferred: "| State | Score |\n| --- | --- |\n| Active | 1 |\n| Active | 2 |" → [2,2,2]
BLOCKQUOTE nesting writes the marker with the quote prefix: "> <!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->"
RADIO_TABLE (paper mode: row0 = [stub, "Model" rowspan 2, "SA-Co/Gold" colspan 8]; stub "C-RADIOv4" rowspan 2; untouched → exact bytes):
"|  | Model | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold | SA-Co/Gold |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n|  | Model | metaclip_nps | sa1b_nps | crowded | fg_food | fg_sports_equipment | attributes | wiki_common | Avg |\n| C-RADIOv4 | SO400M-VDT8 | 43.0 | 44.5 | 54.9 | 38.4 | 38.4 | 40.3 | 22.2 | 40.3 |\n| C-RADIOv4 | SO400M-G | 43.8 | 45.7 | 55.9 | 40.1 | 39.8 | 41.6 | 23.1 | 41.4 |"
```
Merging cells with equal text shows the text once (no "GroupGroup"). Merging distinct texts shows
every value in the merged cell and keeps every value in the output. The exact bytes of a
distinct-value merge are **not pinned**.

**R-BLK-12: Thematic break.** `---` renders as a rule. Clicking it selects it as a block.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2486`.

**R-BLK-13: Headings and the section rail.**
- `#`–`######` render as headings, with IDs slugged from their text; duplicates get `-1`, `-2`
  suffixes.
- A "Document sections" navigation lists the section headings, indented by relative depth. The
  top-level title heading is not listed.
- The current section is marked (`aria-current="location"`), and arrow keys move a roving focus.
- Hovering the rail previews a section, and clicking scrolls to its heading.
- The rail is hidden when there is only one section.
- An authored "Contents" section is listed normally.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:340 "builds an interactive section rail from rendered Markdown headings, including an authored Contents, but not for a single section"`, `:371 "keeps duplicate heading IDs aligned with the editor"`.

**R-BLK-14: Generated paper Contents.** In paper reading mode a converter-generated
"## Contents" list is hidden from view (`aria-hidden`, not removed). It stays in the Markdown and
out of the rail, and block controls keep working. The hiding holds across virtualized chunk
boundaries.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:382 "hides a generated paper Contents block without breaking block controls"`, `:406 "keeps generated Paper Contents hidden across a passive viewport chunk boundary"`.

**R-BLK-15: Paper figures `[KEEP]` (converter output Lattice uses today).**
`<PaperFigure id>` / `<PaperFigureRow columns="3 3 3">` / `<PaperFigurePanel id>` nest and render
as follows:
- a multi-panel figure row, with each column share taken from `columns`;
- panel anchors keyed by `id`, including an empty placeholder panel;
- images inside panels, with italic captions.

Editing a caption keeps the whole component structure.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2871 "renders extracted multi-panel paper figures with source slots and alignment"`.
*Scope:* kept as a paper-reader rich block, because paper reading uses it today; until the engine renders it, it is a byte-preserved raw block.

**R-BLK-16: Unknown components → raw source block.** An unregistered component becomes a group
named "Unknown component: <Name>" containing a nested source editor with the exact bytes. Editing
in the nested editor writes back. Remote canonical changes reconcile into the nested editor without
a write-back.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2044`, `:2063`.
```json
in: "Before\n\n<Unknown>\n\nExact source\n\n</Unknown>"; replace the nested text → "Before\n\n<Unknown>\n\nUpdated source\n\n</Unknown>"
```

**R-BLK-17: Mirror / MirrorSource `[DROP→RAW]`.** `<Mirror src="source" anchor="shared" />` shows a
read-only live copy of `<MirrorSource id="shared">…</MirrorSource>` from another document
(`source.md`) through the workspace index, including updates.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2022 "renders a read-only MirrorSource indexed %s the mirror mounts and refreshes it"`.

**R-BLK-18: Embed / Pdf / Video / Audio / File `[DROP→RAW]`.** These components exist in the
parser. Unsafe `src` values become inert: `javascript:` and `file:` never reach the DOM, and an
Embed with an unsafe scheme shows a placeholder instead of an iframe. They are excluded from the
slash menu.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2004`;
`:1710` (no Video or Audio option) and `:1723 "localizes add-menu options and descriptions in Chinese"`
(the complete item list, which has none of these five).

**R-BLK-19: Lists and task lists.**
- Typing `[] `, `[ ] `, `[x] ` or `[X] ` at the start of a paragraph creates a task item.
  `- [ ] ` typed character by character yields one task list, not nested lists. IME chunk
  delivery (`- [] `, `* [x] `) works too.
- Backspace right after the rule reverts to the literal text (`[x] `).
- Typing a marker in a list item's continuation paragraph creates a new task item without
  retagging the outer item.
- Lists never move as a whole at their edges, and moves never join separate lists.

Derived from: `src/editor/markdown/task-list-input-rule.test.ts:66,80,87,97`; `src/editor/markdown/visual-editor-list-movement.test.ts:70 "does not move the entire list at either edge or join different lists"`.

---

### 6. INL: inline marks, links, math

**R-INL-1: Inline marks.** Bold, italic, underline, strikethrough, inline code, highlight and
links are available from the selection toolbar (R-CHR-2). Saved forms are given in R-FMT-1 and §11.
Underline's saved form is **not pinned** by a test.

**R-INL-2: Inline math `[KEEP]`.**
- `$…$` and `\(…\)` render as KaTeX atoms. A selected atom is visibly selected.
- Properties open only when the atom *itself* is selected, not a block that contains it. The
  click that selected the atom must not immediately close the popover.
- The formula field previews live while typing but changes nothing until Enter (R-FMT-12).
- Typing a closing `$` collapses `$x+y$` into an atom.
- Dollar prices stay prose: `It costs $5 and then $10 more.` contains no math.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2619 "collapses typed $formula$ and [label](url) literals into an inline math atom and a link"`,
`:2634 "renders inline math without disabling visual editing and visibly selects the atom"`, `:2655 "opens inline math properties only when the atom itself is selected"`,
`:2694 "keeps the inline math editor open while a formula is typed character by character"`, `:2750 "keeps dollar-denominated prices as prose"`.

**R-INL-3: Links.**
- Typed `[docs](https://example.com)` collapses into a link.
- Clicking a relative project link opens the decoded project path; a fragment is dropped for
  routing. The link text and the display are untouched. See the table below.
- In-document fragments (`#S3.F1`) scroll to the anchor.
- On a paper path, a link to the same paper's arXiv HTML (versioned) is treated as local. A
  subfigure fragment falls back to its figure (`#S7.F10.sf1` → `S7.F10`). A fragment that was not
  converted opens `https://arxiv.org/html/<id>#<frag>`, with the version dropped.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:891 "opens a relative project link containing %s on an ordinary click"`,
`:866 "keeps same-paper arXiv links local, falling subfigures back to their figure, and opens arXiv for omitted fragments"`, `:852`, `:2619`.
```text
active notes/index.md; href → opened path
./Agent%20Memory.md          → notes/Agent Memory.md
./%E7%A0%94%E7%A9%B6.md      → notes/研究.md
./a%2Fb.md                   → notes/a%2Fb.md        (escaped slash stays literal)
./a%5Cb.md                   → notes/a%5Cb.md
./%2E/secret.md              → notes/%2E/secret.md
./%2E%2E/secret.md           → notes/%2E%2E/secret.md
./100%ZZ.md                  → notes/100%ZZ.md        (malformed escape literal)
./Agent%20Memory.md#section  → notes/Agent Memory.md
../sibling/file.md           → sibling/file.md
```

**R-INL-4: Hard breaks and copy.** A backslash-newline and `<br>` render as line breaks. Copying
as plain text renders links as their text, turns hard breaks into `\n`, and omits the thematic
break.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2148 "copies line breaks as newlines without applying citation labels to other nodes"`.
```json
in:         "Native models.\\\nVisual features.<br>Language connection.\n\nSee [Study](.research/papers/study/paper.md).\n\n---\n\nConclusion."
text/plain: "Native models.\nVisual features.\nLanguage connection.\n\nSee Study.\n\nConclusion."
```

**R-INL-5: Inline HTML** (`<kbd>`, `<script>…</script>`, entities) is preserved byte-exact
(R-RT-12). How it renders is not pinned beyond "the document stays editable".

**R-INL-6: Wiki links `[KEEP]`.**
- `[[Page]]` and `[[Page#heading-slug]]` in a document are kept byte-exact and link to that
  project page (R-FMT-18).
- Typing `[[` offers page titles from the workspace index, filtered as the user types.

*Not evidenced:* the suggestion menu's labels, keys and create-page flow, and how a link with
percent escapes resolves. The only test of the menu is excluded (Part I); phase 2 specifies it
from Lattice UX before building it.

The workspace index:
- takes the title from the first H1, falling back to the file name;
- builds heading slugs with duplicate suffixes, and skips frontmatter and fenced code;
- ranks an exact title first, supports CJK and mixed-script search, and keeps source order for an
  empty query;
- applies live content updates, notifies subscribers on every mutation, and coalesces concurrent
  refreshes to the newest one.

Derived from: the rebuild's keep list (Part I, "Rebuild scope"); `src/editor/markdown/markdown-workspace-index.test.ts:16,36,43,50,67,81,96`.

**R-INL-7: Paper citations `[KEEP]`.**
- Typing `@` opens "Paper citation suggestions". It lists only papers with local content (full
  text or blog) and matches every query token against title and citation key. All matches are
  listed and scroll; the first is preselected. ArrowDown, Enter and Tab work. No match shows "No
  matching papers".
- Existing Markdown links to `.research/papers/…/paper.md` (or `blog.md`) open as atomic citation
  chips. Ordinary links are unaffected. Backspace or Delete removes the whole chip.
- The hover pencil edits "Citation title" and "Link URL". Escape cancels. `javascript:` is
  rejected. A safe external URL turns the chip into an ordinary link. Remove leaves plain text.
- Titles with punctuation (`A [B] & C: *results*`) round-trip and survive HTML copy/paste.
- Dropping a paper from another project is ignored, as is any drop into a read-only editor.

Derived from: `src/editor/markdown/visual-paper-citation-suggestion.test.tsx:41,51,69,88,101,117,129,148,169,177`.
```json
"Before [Attention](../.research/papers/1706.03762/paper.md) and [Docs](https://example.com)." (notes/reading.md) round-trips; text "Before Attention and Docs."; Delete at chip → "Before  and [Docs](https://example.com)."
"Before [Attention](.research/papers/1706.03762/paper.md) after" → title "My reading notes", URL ".research/papers/1706.03762/blog.md" → "Before [My reading notes](.research/papers/1706.03762/blog.md) after" → Remove → "Before My reading notes after"
"[Attention](.research/papers/1706.03762/paper.md)" → URL "javascript:alert(1)" → unchanged; URL "https://example.com/paper" → "[Attention](https://example.com/paper)"
```

**R-INL-8: Inline images.** An image inside a paragraph keeps its exact source (R-RT-12k, R-RT-16).

---

### 7. CHR: chrome (concise)

**R-CHR-1: Slash menu.**
- Typing `/` opens a searchable listbox, "Slash commands", with grouped options, a description
  preview panel, and a scrollbar. Hover and the arrow keys share one active option.
- No match shows a "No results" status, removes the listbox, and clears `aria-controls` and
  `aria-activedescendant` from the surface.
- Choosing an item removes the `/query` text.
- Labels and descriptions follow the UI locale, and the menu updates on a locale change.
- Unmounting while open does not throw.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1699,1710,1723,1748`. Items: §12.

**R-CHR-2: Selection toolbar.**
- A text selection shows an accessible toolbar portalled to the body. It holds a block-type
  selector and the buttons Bold, Italic, Underline, Strikethrough, Inline code, Highlight, Insert
  link, Convert selection to footnote, Convert selection to inline math, and View in source
  Markdown. It has no Undo.
- The block-type menu has 12 entries (including Text, Heading 1–6 and Task list), with 3
  separators and a check on the active entry.
- The toolbar hides on blur.
- In a read-only document only "Comment" is offered.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1602 "shows an accessible contextual toolbar for a text selection"`, `:1639`, `:1660 "offers all Markdown heading levels in the contextual block menu"`, `:842`.

**R-CHR-3: Find and replace.**
- Cmd-F opens a local "Find in document" search. Cmd-Shift-F is not intercepted, because it
  belongs to project search.
- Matching is case-insensitive, with a "1 of 2" status. Enter moves to the next match.
- Escape closes, clears highlights, and refocuses the editor.
- Cmd-Alt-F opens the bar with Replace expanded and seeds Find from a short selection.
- "Replace all matches" and "Replace current match" are disabled when the document is not
  editable.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:3017 "opens local find, highlights and navigates matches, then clears on Escape"`, `:3037 "expands replace, replaces matches, and seeds a short text selection"`, `:2516`.

**R-CHR-4: Link editor and link hover.**
- The link editor pre-fills the "Link URL" field and hides the selection toolbar. Clicking
  outside commits; Done commits; Remove unlinks.
- Path suggestions stay closed while the field is empty.
- Hovering a link opens a preview after a 300 ms dwell and closes it 150 ms after leaving.
- A relative project link offers "Edit link" and fetches no metadata.
- External link metadata is fetched through the host and cached in an LRU. Concurrent requests
  are coalesced. A blocked response is not cached; a malformed response or an aborted request
  yields none.
- Favicons are shown only from `data:` URIs.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2121,2089`; `src/editor/markdown/visual-link-hover.test.tsx:35,52,61,70,81,107,120`.

**R-CHR-5: Block controls and drag.**
- Hovering a block shows "Add block below" and a "Select block" grip. List items get a "Select
  list item" grip, reachable across the marker gutter in both LTR and RTL. Hovering the list
  gutter shows "Select numbered list".
- Add-below inserts a paragraph containing `/`, leaves the caret after it, and opens the slash
  menu without scroll jumps. The viewport is preserved through deferred publication, and a block
  added below the fold is revealed with about 40 px of breathing room.
- A drag shows a ghost that keeps the source font metrics. The drop line is rendered outside the
  clipped viewport, and list drops are limited to the list and its end gap.
- Delete removes a node-selected block.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1151,1205,1263,1285,1299,1322,1372,321`.

**R-CHR-6: Native selection.** Native selection highlighting is hidden only for a whole-node
selection, not for text ranges that contain rich blocks.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:247 "hides native selection only for a NodeSelection, not ranges containing selected NodeViews"`.

**R-CHR-7: Emoji.** "Emoji" in the slash menu removes the query and opens a searchable emoji
picker; picking inserts Unicode (R-FMT-19).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1811`.

**R-CHR-8: Component property panel `[DROP→RAW for generic panel]`.** Components expose a
"<Name> properties" button that opens a properties popover. The popover stays mounted while the
user types, commits title fields on Enter, and has no advanced or align section for images. The
generic icon and color pickers are dropped; keep-list blocks need only their own fields.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1874,1913,2975`.

**R-CHR-9: Frozen table headers** stay pinned while scrolling (scroll-driven, with a WebKit
fallback). Their animations are cancelled when a document replacement drops the table.
Derived from: `src/editor/markdown/frozen-table-headers.test.ts:38,48,55`; `src/editor/markdown/frozen-table-headers-lifecycle.test.ts:69`.

---

### 8. SRC: source mapping (concise)

**R-SRC-1: Local caret → source row and column.** The visual caret is reported in Markdown
(row, column) coordinates, UTF-16, correct across the cases below.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:515,578,592`.
```text
"# Hello", caret after "He"                        → (0,4)
"**bold**", caret after "bo"                       → (0,4)
"**bold**\n\n- one\n- two 😀", caret at end        → (3,8); after typing "!" → (3,9)
"A\r\n\r\nB\r\n", caret after "B"                   → (2,1)   (CRLF coordinate space)
"<Callout title=\"Exact\">\n  Body\n</Callout>", caret after "Bo" → (1,4)   (untouched MDX body)
```

**R-SRC-2: Remote cursors.** Remote (Overleaf) cursors draw a labelled caret (name, colored
background) at the mapped position, including inside code blocks, where they update as the cursor
moves. A cursor at `(0,3)` in `# # Title` lands inside the heading after the visible `#`. Cursors
are rebuilt after a canonical replace. A table cell cursor is `aria-hidden`, is not an editable
widget, and does not block local clicks in that cell.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:515,529,599,606,622`.

**R-SRC-3: Unmappable positions are omitted, never misplaced.** A cursor on a code-fence line, on an
image atom, or inside an inferred paper span is not drawn. Surrogate pairs are never split.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:572 "does not misplace an unmappable source-only cursor from %s"`, `:613 "keeps source positions after an inferred paper table aligned"`.

**R-SRC-4: Table coordinates.**
- A cursor on the delimiter row anchors in the corresponding header cell, including below an
  escaped-pipe header, an empty header, or a one-column table.
- A dash-only *body* row stays a body row.
- In an explicit merged span, every covered source coordinate maps to the origin cell.

Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:655 "anchors %s"`, `:642 "maps an explicit merged cell cursor from source column %i to its visual origin"`.
```json
"| A \\| B | C |\n| --- | --- |\n| x | y |"  row 1 col 3 → header cell
"| Left | Right |\n| --- | --- |\n| --- | --- |" row 2 col 3 → body cell
MERGED_LAYOUT_TABLE row 2 col 3 or col 11 → the colspan=2 header
```

**R-SRC-5: Comment anchoring.** A comment's source range is computed from the visual selection
without normalizing tight blocks, CRLF, or the whole-document selection.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:817 "anchors comments without normalizing tight Markdown blocks: %j"`.
```json
"## Intro\n\nA paragraph\n- one\n- two\n\nText" select "A paragraph" → (indexOf("A paragraph"), +11), quote "A paragraph"
same with \r\n → same substring semantics in CRLF offsets
select all → (0, text.length), quote = entire text; no publication
```

**R-SRC-6: Comment composer.** The "Comment" action opens "Add comment" showing the quote. The
selection stays highlighted while composing. If the document changes while composing, the range is
remapped (inserting "New " at the start shifts `(0,5)` to `(4,9)`). Cancel and Escape leave nothing
behind. Two failure messages exist: "Cannot precisely locate this selection in Markdown source.
Switch to Source view to add a comment." and "The selected text changed. Select it again before
commenting."
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:786`; `src/locales/en/messages.po`.

**R-SRC-7: Comment display.** Unresolved comments highlight exactly their quoted text; resolved
comments are not painted. Hover or focus shows a tooltip with the author, body and replies, which
stays open when the pointer moves onto it. Escape, scroll, click and unmount close it. A click
opens the thread.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:673`.

**R-SRC-8: Tracked changes.** Insertions are highlighted. A deletion shows its removed text at its
zero-width anchor (`"H" + "removed" + "ello"`). A "Suggested change" popover shows the author and
Accept/Reject. It survives the pointer gap, and when opened from the keyboard it focuses Accept.
Escape restores focus to the mark. Actions apply to the latest suggestion after a canonical update.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:716,735,760,771`.

**R-SRC-9: Read-only commenting.** Commenting works in read-only documents.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:842`.

**R-SRC-10: Frontmatter offsets.** The host maps comment offsets around frontmatter: visual
offsets exclude it, creation offsets add it back, and comments inside it are hidden.
Derived from: `src/canvas/document-canvas.test.tsx:278`.

**R-SRC-11: View in source.** Each top-level block exposes its 1-based source line and start and
end source offsets. "View in source Markdown" reports the exact source offset of the selection
start, in both reading and normal mode.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1676 "maps View in source to the selected text when reading optimization is %s"`.

**R-SRC-12: Selection as Markdown context.** A node-selected block (or a grip press) reports that
block's Markdown source, such as `## Selected context`. The agent context receives it. For a
selected WebP image the host also supplies a PNG conversion path.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1273 "reports a selected visual block as Markdown context"`; `src/App.test.tsx:3845,3905`.

**R-SRC-13: Large-document mapping cost.** For large documents, caret-to-source mapping is scoped
to the containing block when block ownership is exact. It must not reparse or reserialize the
whole document on every keystroke.
Derived from: `docs/performance.md:278`.

---

### 9. PERF: virtualization and large documents (concise)

**R-PERF-1: Passive read-only view.** A large read-only document (180 blocks in the tests) renders
virtualized, with fewer than 10 chunks mounted. Links work, and project links open. "Edit document"
switches to the complete surface. Nothing is ever published from the passive view.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:423`.

**R-PERF-2: Paper fragments in the passive view.** In the passive view a paper fragment link
activates the complete surface and then scrolls to its target. A fragment with no target opens
arXiv.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:447 "resolves paper fragments after activating a virtualized paper"`, `:465 "opens arXiv when a virtualized paper has no converted fragment target"`.

**R-PERF-3: Editable documents are never virtualized.** A large *editable* document keeps one
scroll geometry.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:476 "keeps one scroll geometry when a large editable document is clicked"`.

**R-PERF-4: Passive math and media.** The passive view renders formulas immediately, with no
placeholder flash, and defers off-screen images (no asset read).
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:482 "renders passive formulas without an intermediate source placeholder"`.

**R-PERF-5: Block model.** Virtual blocks exist only under exact ownership. Leading bytes, blocks,
gaps and trailing bytes must re-concatenate to the body byte-for-byte, with a BOM offset base.
Duplicate blocks get distinct IDs. The model is refused when:
- the document is unmappable;
- there are fewer than 2 blocks;
- one root is too large to bound the mounted window (a single 900-item list, for example).

Derived from: `src/editor/markdown/visual-markdown-block-model.test.ts:5,24,31,37`.
*Not evidenced:* the exact size thresholds and the minimum block count.

**R-PERF-6: Near-viewport materialization.**
- One shared buffered observer and one visibility observer exist per scroll root.
- Content entering the buffer is staged for 32 ms. Visible content materializes immediately.
- Content leaving the buffer is released after 3 s, unless it re-enters first.
- Media inside a list item preload from the item's boundary.
- Nothing materializes after exit or unmount.
- Without IntersectionObserver, everything is visible.

Derived from: `src/editor/markdown/use-near-viewport.test.tsx:57,83,105,115,130,136`.

**R-PERF-7: Project image host.**
- A transient failure retries after 250 ms; failures are bounded to 3 reads and then reported as
  missing.
- A resolved source is kept for 5 s after leaving the viewport.
- The old image stays shown while a newer revision loads.
- A single decoded source over 24 MiB is not cached.
- The cache is bounded to 48 entries, and abandoned pending reads are evicted too.

Derived from: `src/editor/markdown/project-image-host.test.tsx:34,49,63,77,95,113`.

**R-PERF-8: Complete-editor math.** The complete editor renders math before any viewport
intersection.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:2643`.

**R-PERF-9: No remounts or reloads.** Adjacent inserts cause no remounts and no reloads (R-PUB-21).
The editor instance is reused across files (R-PUB-8).

**R-PERF-10: Publication budget.** Publication follows the sync policy in R-PUB-2, and publishing
never re-parses or re-serializes the whole document for a local edit (R-SRC-13).
Derived from: R-PUB-2; `docs/performance.md:278`.
*Not evidenced:* any parse cache and its bounds.

---

### 11. Saved-file formats Lattice writes

Each entry names the syntax, gives a byte-exact example (JSON literal) or raw bytes, and cites the
evidence. "Written by" separates editor actions (E), the arXiv converter (C), the tutorial template
(T), and host actions (H). The new engine must read all of these, write them back byte-exact when
untouched, and write the E forms on the listed actions.

**11.1 File envelope (E/C/H).**
- BOM `\uFEFF`, CRLF line endings, and the exact trailing-newline run are preserved (R-RT-6..8).
- YAML frontmatter is preserved.
- The converter writes frontmatter with quoted `title`, plus fields such as `url`, `sections`,
  `estimated_tokens` and `authors`.
```json
"\uFEFFHello world\n"
"\uFEFFChanged\r\n\r\n"
"---\ntitle: \"Attention Is All You Need\"\nsections: 28\n---\n\n## Contents\n"
"---\ntitle: \"T\"\nauthors: [\"A\", \"B\"]\n---\n\nOne sentence that was wrapped, and continues here. Still the same paragraph.\n"
```
Cite: `src/editor/markdown/markdown-collab.test.ts:51`; `src-tauri/src/papers/markdown.rs:409-412,479-481,494`.

**11.2 Block Markdown (E/T).** The editor and tutorial write:
- ATX headings `#`–`######`;
- paragraphs;
- `- ` bullets, with nested items indented 2 spaces;
- ordered `N.` items that keep the authored start number;
- task items `- [ ]`, `- [x]` and `- [X]`;
- blockquotes `> `, with `>` on blank lines;
- a `---` thematic break.
```markdown
- Values carry the information that gets combined.
  - A nested item can add detail without starting a new section.
1. Compute scaled query–key scores.
- [x] Add the original Transformer paper.
- [ ] Compare the explanation with the interactive HTML demo.
> Attention is a routing mechanism: each output combines values according to query–key compatibility.
>
> A block quote can contain more than one paragraph when an explanation needs context.
```
Cite: `src-tauri/templates/tutorial/notes.md:15-19,36-54`; `src/editor/markdown/visual-editor-list-movement.test.ts:40`.

**11.3 Inline marks (E/T).** `**strong**`, `*italic*`, `***bold italic***`, `~~strike~~`,
`` `code` ``, `==highlight==`, and a literal escape `\*`. Underline is not pinned.
```markdown
Combine **strong emphasis**, *italics*, ***bold italics***, ~~revisions~~, `inline code`, and a [link to the original paper](https://arxiv.org/abs/1706.03762) in ordinary prose.
An escaped character such as \* remains literal, and an emoji such as 🧭 can sit beside regular text.
==Hello==   (editor-written highlight; not in the tutorial)
```
Cite: `src-tauri/templates/tutorial/notes.md:11-13`; `src/editor/markdown/visual-markdown-editor.test.tsx:1594`.

**11.4 Links (E/C).**
- Inline links `[text](url)`, and relative project links with percent-escapes.
- In-document fragments `[1](#S3.F1)`.
- Reference links `[t][ref]` with a definition `[ref]: url "Title"` (preserved).
- The converter rewrites Contents entries into heading-slug links. Slugs are made by NFKD,
  stripping combining marks, lowercasing, and joining alphanumeric runs with `-`; duplicates get
  `-1`, `-2`. The converter also localizes same-paper arXiv URLs to fragments.
```json
"- [1 Introduction](#1-introduction)"
"  - [1.1 Setup](#1-1-setup)"
"- [Diffusion Models.](#diffusion-models)\n"   then  "- [Diffusion Models.](#diffusion-models-1)"
"See [Figure 10(a)](#S7.F10.sf1), [the paper](https://arxiv.org/html/2407.06438v3), and [another paper](https://arxiv.org/html/2407.00001#S1).\n"
"Editable paragraph\n\nRead [Results][paper].\n\n[paper]: results.md \"Title\""
```
Cite: `src-tauri/src/papers/markdown.rs:199-276,278-290,427-469`; `src/editor/markdown/visual-markdown-editor.test.tsx:2455,891`.

**11.5 Images (E/T/H/C).**
- Markdown images: `![alt](src)`, `![alt](src "title")`, and an angle-bracket destination.
- HTML images: `<img src="…" />` with optional `alt="…"`, `title="…"`, `width={N}` and
  `align="…"`, where N is an integer JSX expression. There is never a height.
- The converter replaces unrendered source images with a quoted placeholder:
  `> **Figure:** <caption>`, or `> **Figure unavailable in source conversion.**` when there is no
  caption.
```json
"![Plot](figures/plot.png \"Results\")"
"Before ![Plot](<../figures/my plot.png> \"Results\") after"
"<img src=\"\" />"
"<img src=\"figures/uploaded.png\" />"
"<img src=\"figures/scaled-dot-product-attention.png\" alt=\"Scaled dot-product attention from Figure 2 of the Transformer paper\" width={223} />"
"<img src=\"figures/plot.png\" alt=\"Plot\" width={223} />"
"> **Figure:** <caption>"      "> **Figure unavailable in source conversion.**"
```
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:2478,2455,1774,1801,2975,2998`; `src-tauri/templates/tutorial/notes.md:105`; `src/App.test.tsx:4198`; `src-tauri/src/papers/markdown.rs:315-332`.

**11.6 Code fences with metadata (E/T).**
- Backtick and tilde fences, of 3 or more characters, with open and close lengths preserved.
- The info string is `<lang>` then optional tokens: `title="…"`, and for previews `preview`,
  `w=<n>px`, `h=<n>px` and unquoted `align=<left|center|right>`.
- Language casing is preserved (`MerMaid`).
```json
"```python title=\"Scaled dot-product attention in NumPy\"\n…\n```"
"```mermaid title=\"From queries and keys to contextual representations\"\nflowchart LR\n…\n```"
"```html preview h=360px title=\"Embedded attention demo\"\n<!doctype html>\n…\n```"
"```mermaid title=\"Example\" w=320px\ngraph TD; A-->B\n```"
"```ts title=\"Example with spaces\"\nconst answer = 42;\n```"
"Editable\n\n````text\n```\n````"      "Editable\n\n~~~~MerMaid\ngraph TD; A-->B\n~~~~~"
"```js\n\n```"   (empty fence)
```
Cite: `src-tauri/templates/tutorial/notes.md:80,109,123`; `src/editor/markdown/visual-markdown-editor.test.tsx:1532,1573,1829,2455,1517`.

**11.7 Math delimiters (E/C/T).**
- Inline: `$…$`, which is what edits write, and `\(…\)`, which is preserved when untouched.
- Display: `$$` on its own lines, multi-line `\[`…`\]` (preserved), and single-line `\[…\]`
  (preserved).
- The converter guarantees a blank line before a `$$` block that follows text.
```json
"Inline math such as $d_k=64$ and $QK^\\top$ stays editable"
"$$\n\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V\n$$"
"Intro paragraph.\n\n\\[\nE=mc^2\n\\]\n\nInline \\(x_i\\) math."
"\\[E=mc^2\\]\n"
"<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$"   (converter adds the blank line between anchor and $$)
```
Cite: `src-tauri/templates/tutorial/notes.md:12,71-73`; `src/editor/markdown/visual-markdown-editor.test.tsx:2455,2781,2680`; `src-tauri/src/papers/markdown.rs:181-197,388-389`.

**11.8 Footnotes (E/T).** A reference `[^id]` and a definition `[^id]: text`. Continuation
paragraphs are indented 4 spaces; internal double spaces are preserved.
```json
"Footnotes keep supporting context close without overloading the main paragraph.[^components]\n\n[^components]: Type `/` on an empty line to browse everything that can be inserted."
"Evidence[^source].\n\n[^source]: Supporting **result**.\n\n    Second **paragraph**."
"[^note]: Keep  two spaces"
```
Cite: `src-tauri/templates/tutorial/notes.md:179-181`; `src/editor/markdown/visual-markdown-editor.test.tsx:2075,2463`.

**11.9 Wiki links (E).** `[[DocName]]` and `[[DocName#heading-slug]]`, kept byte-exact.
Cite: the rebuild's keep list; `src/editor/markdown/markdown-workspace-index.test.ts:36,43`.
*Not evidenced:* the unresolved-page and percent-escape forms (R-INL-6).

**11.10 Paper citations (E).** A plain Markdown link to the paper file:
`[<title>](<rel>.research/papers/<arxivId>/paper.md)` or `…/blog.md`. A pointer drop uses the
`[@<citationKey>](…)` label form. There is no special syntax: a citation is recognized purely by
its target path.
```json
"Before [@vaswani2017attention](../.research/papers/1706.03762/paper.md)after"
"[An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)"
"[Attention Is All You Need](../.research/papers/1706.03762/paper.md)"
```
Cite: `src/editor/markdown/visual-paper-citation-suggestion.test.tsx:51,177,198-201`.

**11.11 MDX components (E/T/C), exact attribute spellings.**
- Boolean shorthand `defaultOpen`; boolean false `collapsible={false}`.
- Numbers as JSX expressions (`width={223}`).
- Plain strings quoted. Strings with `&` or `"` are written as a JSX expression string:
  `title={"Changed & quoted \"title\""}`.
- Unknown components are kept verbatim.
```text
<Callout type="note" collapsible={false} defaultOpen>

</Callout>
<Callout type="important" title="Attention maps need validation">
Attention weights show routing patterns, but they do not establish causality. …
</Callout>
<Accordion title="Why scale attention scores?" defaultOpen>
Scaling keeps the softmax distribution and its gradients well behaved.
</Accordion>
<Tabs> … <Tab label="Tab 1"> … <Tab label="Tab 2"> … </Tabs>        [DROP→RAW]
<Mirror src="source" anchor="shared" />                               [DROP→RAW]
<MirrorSource id="shared">

**First version**

</MirrorSource>                                                        [DROP→RAW]
<Embed src="…" />   <Pdf src="…" />                                    [DROP→RAW]
<PaperFigure id="S2.F1">
<PaperFigureRow columns="3 3 3">
<PaperFigurePanel id="S2.F1.placeholder">
</PaperFigurePanel>
<PaperFigurePanel id="S2.F1.sf1">

![First panel](paper_assets/first.webp)

*(a) Swiss Roll*

</PaperFigurePanel>
</PaperFigureRow>

*Figure 1: Manifold examples.*

</PaperFigure>
```
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:236,1874,1783,2022,2004,2871`; `src-tauri/templates/tutorial/notes.md:23-32`.
*Gap:* the writer of `<PaperFigure…>` is outside the allowed sources; only the editor test
evidences it. Blank-line placement inside the figure is taken from that test's fixture.

**11.12 Legacy component fence (read, migrated on edit).** The info string is
`rw-component <kind>`; only kind `callout` is recognized. The body is a JSON object: `content`
becomes the body and the other keys become attributes.
```json
"```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```"
```
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:1988`. Only the `callout` kind is
evidenced; other kinds are *not evidenced* (R-FMT-6).

**11.13 Table span layout marker (E).** An HTML comment on its own line, followed by a blank line,
immediately before a GFM table:
`<!-- lattice-table-layout:v1 {"spans":[[row,col,rowspan,colspan],…]} -->`.
- The JSON is compact, with no spaces.
- Row 0 is the header row. Body rows are 1-based and skip the delimiter row. Columns are 0-based.
- Covered source cells repeat the origin cell's text.
- `{"spans":[]}` is an explicit "no spans" that suppresses paper inference.
- Inside a blockquote each line carries the `> ` prefix. The last example below is the test's
  *input*; only the serialized marker line `> <!-- lattice-table-layout:v1 … -->` is pinned.
- An out-of-grid span means the comment is preserved as a raw comment and the table is unmerged.
```json
"<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->\n\n| Group | Group | Metric |\n| --- | --- | --- |\n| A | B | 1 |"
"<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2],[0,2,1,2]]} -->\n\n| Left | Left | Right | Right |\n| --- | --- | --- | --- |\n| A | B | C | D |"
"<!-- lattice-table-layout:v1 {\"spans\":[[0,0,2,2]]} -->"      "<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,5]]} -->"
"<!-- lattice-table-layout:v1 {\"spans\":[]} -->"
"> <!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->\n>\n> | Group | Group | Metric |\n> | --- | --- | --- |\n> | A | B | 1 |"
```
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:218-224,2251,2260,2280,2293,2307,2329,2344`.

**11.14 GFM tables (E/T).**
- The canonical form pads cells with single spaces: `| A | B |`.
- The delimiter row is `| --- |`, with alignment spellings `:---`, `---:` and `:---:`, which are
  preserved.
- Pipes inside cells are escaped as `\|`. Empty cells are written `|  |`.
- Inline math is allowed in cells.
```json
"| Component | Shape | Purpose |\n| --- | --- | --- |\n| Queries | $n \\times d_k$ | Express what each token seeks |"
"| Group | Group | Metric |\n| :--- | ---: | :---: |\n| A | B | 1 |"
"| A \\| B | C |\n| --- | --- |\n| x | y |"
```
Cite: `src-tauri/templates/tutorial/notes.md:58-63`; `src/editor/markdown/visual-markdown-editor.test.tsx:2307,655`.

**11.15 Converter anchors and normalization (C).** Figure, equation and section anchors are
written as `<a id="…"></a>` on their own line, separated by blank lines. At import the converter
normalizes as follows:
- the `- •` bullet glyph is folded into the item;
- `- (1)` / `- 1.` enumerate labels become `1.` ordered items, with their continuations joined;
- hard-wrapped prose is unwrapped; structure, indented lines and hard breaks (a trailing two
  spaces or `\`) are left alone;
- a blank line is inserted between a heading and a directly following `- ` list;
- TikZ/PGFPlots `<details>` source blocks are removed.

Frontmatter and code fences are untouched.
```json
in:  "## Contents\n- Intro\n\n<a id=\"eq\"></a>\n$$\nx_{p} \\%\n$$\n\n- •\nContinuation with $x_{p}$\n"
out: "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- Continuation with $x_{p}$\n"
in:  "- •\n  $p(\\textbf{x}|c)$. First item.\n- •\n  Second item.\n  - •\n    Nested item.\n"
out: "- $p(\\textbf{x}|c)$. First item.\n- Second item.\n  - Nested item.\n"
in:  "- 1.\nFirst answer.\n- 2.\nSecond answer.\n"
out: "1. First answer.\n2. Second answer.\n"
in:  "- •\n  (1)\n  Constrained visual capabilities.\n2. Existing ordered item.\n"
out: "1. Constrained visual capabilities.\n2. Existing ordered item.\n"
unchanged: "Before math\n\n$$\na = b\n+ c\n$$\n\n```\nline one\nline two\n```\n"
```
Cite: `src-tauri/src/papers/markdown.rs:16-197,295-313,383-424`; `src/editor/markdown/visual-markdown-editor.test.tsx:852`.
*Note:* the converter's raw output, before this normalization, also contains `- •` items and bare
`1.` / `2\.` ordinals. The editor must accept both (R-ELIG-3/4, R-RT-22).

**11.16 Raw HTML (preserved, never written by the editor).** Inline `<kbd class="key">&copy;</kbd>`,
`<kbd>Ctrl</kbd>`, `<script>…</script>`, and `<br>`; block `<aside data-kind="note">…</aside>`,
`<!-- … -->` comments, and `<details>`; entities such as `&copy;`.
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:2455,2148,243`.

**11.17 Hard breaks.** A backslash-newline `\` + `\n` and `<br>` are preserved. Two or more
trailing spaces are significant; a single trailing space is not (R-ELIG-2).
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:2148`; CommonMark 0.31 §6.7.

**11.18 Hashtags and emoji.** `#Tag` stays literal text with no escaping. Emoji are raw Unicode
(`🧭`).
Cite: `src/editor/markdown/visual-markdown-editor.test.tsx:2105,1811`; `src-tauri/templates/tutorial/notes.md:13`.

**11.19 `%%` comments. NO EVIDENCE.** No allowed Lattice source (tests, converter, tutorial,
docs, English catalog) contains `%%`-comment syntax. Treat `%%` as ordinary
text that must round-trip byte-exact. The rebuild drops "%% comment styling".

---

### 12. Slash menu items Lattice exposes today

The menu has 28 items, in the order pinned by the zh-CN test. The zh-CN test also pins four
visible group headings (基础块, 插入, 组件, 媒体). English labels are given where an English test
pins them; the others are the zh-CN label's evident meaning and are marked *(zh-CN)*.
Derived from: `src/editor/markdown/visual-markdown-editor.test.tsx:1723 "localizes add-menu options and descriptions in Chinese"` (the complete, ordered list),
`:1710 "offers the complete set of Markdown-native insertions and unmounts the open menu cleanly"` (English labels),
`:1699 "opens a searchable slash menu and inserts Heading %i"`, `:1774 "inserts %s"`, `:1783`, `:1801`, `:1811`, `:1829`, `:1864`.
What an item inserts is given only where a test pins it; otherwise it is *not pinned*.

| # | Label (zh-CN / en) | What it inserts (evidence) | Rebuild scope |
|---|---|---|---|
| 1–6 | 一级标题 … 六级标题 / Heading 1 … Heading 6 | Turns the block into an H1–H6 heading (`…:1699`) | Markdown-native |
| 7 | 无序列表 / bullet list *(zh-CN)* | Not pinned | Markdown-native |
| 8 | 有序列表 / ordered list *(zh-CN)* | Not pinned | Markdown-native |
| 9 | 任务列表 / Task List | Not pinned | Markdown-native |
| 10 | 引文 / quote *(zh-CN)* | Not pinned | Markdown-native |
| 11 | 代码块 / Code Block | Not pinned | **KEEP** (code blocks) |
| 12 | 表格 / Table | Not pinned | **KEEP** (tables with spans) |
| 13 | 分隔线 / separator *(zh-CN)* | Not pinned | Markdown-native |
| 14 | 脚注 / Footnote | Not pinned | **KEEP** (footnotes) |
| 15 | 表情符号 / Emoji | Opens the picker; inserts plain Unicode (`…:1811`) | Markdown-native (no syntax) |
| 16 | 行内公式 / Inline Math | Not pinned | **KEEP** (math) |
| 17 | 链接 / Link | Placeholder `link` plus URL field → `[link](url)` (`…:1864`) | Markdown-native |
| 18 | 提示框 / Callout | `<Callout type="note" collapsible={false} defaultOpen>\n\n</Callout>` (`…:1774`) | **KEEP** (callouts) |
| 19 | 折叠面板 / accordion *(zh-CN)* | Not pinned | **KEEP** (accordions) |
| 20 | 折叠块 / toggle *(zh-CN)* | Not pinned | **DROP→RAW** (Toggle alias) |
| 21 | 标签页 / Tabs | `<Tabs>` + `<Tab label="Tab 1">` + `<Tab label="Tab 2">` (`…:1783`) | **DROP→RAW** |
| 22 | 数学 / math *(zh-CN)* | Not pinned (existing display math saves as `$$\n…\n$$`, §11) | **KEEP** (math) |
| 23 | Mermaid 图表 / Mermaid | Not pinned | **KEEP** (Mermaid) |
| 24 | 镜像 / mirror *(zh-CN)* | Not pinned (the component's syntax is `<Mirror src="…" anchor="…" />`, `…:2022`) | **DROP→RAW** |
| 25 | 镜像源 / mirror source *(zh-CN)* | Not pinned (the component's syntax is `<MirrorSource id="…">…</MirrorSource>`, `…:2022`) | **DROP→RAW** |
| 26 | 对齐块 / align block *(zh-CN)* | Not pinned | **DROP→RAW** (Align) |
| 27 | 图片 / Image | `<img src="" />`, or import → `<img src="<relative path>" />` (`…:1774,1801`) | **KEEP** (images) |
| 28 | HTML | A sandboxed live-preview HTML code block (`…:1829`) | **DROP→RAW** (HTML live-preview starter) |

**Not in the menu today:** Tag, Video and Audio (`…:1710`); PDF, Embed and File, which the
component set contains (`…:1736`) but the complete list (`…:1723`) omits; and Chart (`…:1829`).
The parser still accepts these components. The rebuild's decision is **DROP→RAW** for Video,
Audio, Pdf, Embed and File.

**Not slash items, but in the keep list:** wiki links (triggered by typing `[[`, R-INL-6) and
citations (triggered by `@` and by drag-drop from the Papers list, R-INL-7).

**Also dropped by the rebuild (no slash item):**
- the generic component property panel with icon and color pickers (R-CHR-8);
- `%%` comment styling (no Lattice evidence, §11.19).

---

### 13. Gaps and open questions

1. Exact inserted bytes for these slash items are not pinned by any test: bullet list, ordered
   list, Task List, quote, Code Block, Table, separator, Footnote, Inline Math, accordion, toggle,
   math, Mermaid, mirror, mirror source and align block.
2. The exact layout of the migrated legacy Callout (R-FMT-6), and the bytes of a distinct-value
   cell merge (R-BLK-11), are not pinned.
3. The saved form of Underline is not pinned.
4. `<PaperFigure…>` is evidenced only by an editor test fixture. Its writer is outside the allowed
   sources.
5. No `%%` comment syntax appears in any allowed source.
6. How the current editor writes a file with mixed LF/CRLF line endings (R-RT-7) is not
   evidenced; the new engine declines to edit such files.
7. What the current editor writes for the other blocks after a block-count change (R-RT-5 note)
   is not evidenced.
8. The wiki-link suggestion menu (R-INL-6, R-FMT-18) is not evidenced by an allowed source; its
   only test is excluded. Phase 2 must specify it from Lattice UX first.
9. Legacy `rw-component` kinds other than `callout`, and fences whose JSON is not an object
   (R-FMT-6), are not evidenced.
