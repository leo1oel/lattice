# Performance: diagnosis, playbook, and roadmap

Written after the August 2026 investigation into "long Markdown documents lag
while editing, and file switching is slow". Three codebase surveys plus an
industry comparison produced the findings below; the fixes land in stages,
each measured with the harness in this document.

## What smooth editors do (industry survey)

- **CodeMirror 6** — viewport-only rendering is a foundational design
  decision, not an option; Lezer parses incrementally with a time budget,
  prioritizing the viewport and catching up in idle time. The million-line
  demo stays responsive because *nothing* scales with document length.
  Our source pane (CM6) inherits all of this for free.
- **VS Code / Monaco** — piece-tree text buffer (memory ≈ file size);
  line-level incremental tokenization (state at end-of-line lets an edit
  retokenize a single line); tokens packed into `Uint32Array` to avoid
  object churn; visible content tokenized first, off-screen deferred.
  The transferable rule: **per-keystroke work must be O(viewport) or
  O(change) — never O(document), never O(project)**.
- **Obsidian** — live preview is a single CM6 editor with decorations, not a
  source editor plus a second WYSIWYG DOM tree. Lattice's split mode mounts
  two full editors over the same document, which is a structural cost we
  accept for now (see Future directions).
- **Typora** — sidesteps the problem with a ~2 MB file-size limit. The
  guardrail idea (degrade expensive features by document size) is applied to
  Harper below.
- **Tauri IPC** — string serialization is the bottleneck; batch or
  parallelize round trips, never poll when a watcher will do, keep large
  payloads off the invoke path.

Sources: VS Code blog "Text Buffer Reimplementation" and "Optimizations in
Syntax Highlighting"; codemirror.net million-line example; Tauri discussions
#11915 / #7146 / #5690.

## What was actually slow here (verified findings)

Editing long Markdown:

| Cause | Where |
| --- | --- |
| Visual editor renders the whole document into the DOM; the upstream `content-visibility` chunking plugin was never vendored (CSS was) | `editor-globals.css` `.ok-chunk-wrapper`, upstream `chunk-wrapper-decoration.ts` |
| `HeadingAnchors` rebuilt a whole-document DecorationSet on every view update, including caret-only moves | `open-knowledge-app/editor/extensions/heading-anchors.ts` |
| Every keystroke rebuilt `liveSourceMap` and re-ran four whole-project parses (macros, graphics roots, katex macros, appendix) even for `.md` buffers | `App.tsx` around `liveSourceMap` |
| React Compiler silently bailed out of `App`, `DocumentCanvas`, `VisualMarkdownEditor`, `EditorTabs`, `ContinuousPdfPage` (try/finally, `x++` in lambdas, inline `import()`), so none of the hot tree was auto-memoized | `scripts/react-compiler-report.mjs` finds these |
| Secondary CodeMirror reconfigured all extensions every keystroke in dual/split/columns mode | `document-canvas.tsx` `secondaryEditorExtensions` |
| Comment decorations serialized the whole doc before checking whether any comments exist | `editor-comments.ts` |
| Harper linted the whole document on the main thread every 350 ms of typing | `latex-editor.ts`, `harper-spellcheck.ts` |
| Single-slot mdast cache thrashed by the publication probe: 3 full parses where 1 suffices | `visual-markdown-editor.tsx` |

Slow file switching:

| Cause | Where |
| --- | --- |
| 2-second poll re-read the full bytes of every project file (`scan_files` → `classify_regular_file`) and spawned ~6 git subprocesses per tick | `project.rs`, `git.rs` |
| Every save parsed up to 100 history records (each embedding full before/after contents) to find the newest; dirty switches await the save | `project.rs` `latest_history_record` |
| Collab opens awaited ticket + WebSocket + sync before showing content even when a server-acked local snapshot existed | `collab-project-v2.ts` `openPath` |
| Cursor/scroll restore was gated behind an unrelated `stat` round trip; save and read ran serially | `App.tsx` `loadFile` |
| `read_file` read every file twice (classification pass + content pass) | `project.rs` |

Ruled out: agent streaming (cross-origin iframe + postMessage, zero React
cost), Tauri `listen()` handlers (8 total, all cleaned up), file tree
(already virtualized).

A constraint to respect: **editable surfaces deliberately do not use
`content-visibility: auto`** — deferred materialization destabilizes WebKit
selection anchoring (see the comment on `.ok-chunk-wrapper` in
`editor-globals.css`). The chunking plugin is therefore gated to read-only
surfaces (`optimizeForReading`); enabling it for editable docs is a separate
experiment behind a flag, measured before adoption.

## Measurement playbook

1. Generate the fixture project (byte-stable across runs):
   `node scripts/gen-perf-fixture.mjs /tmp/lattice-perf-fixture`
2. In the dev app, run `localStorage.setItem("lattice-perf", "1")` in the
   webview console and reload. The probe logs
   `[lattice-perf] probe installed`.
3. Open the fixture project. Scenarios, in order, calling
   `__latticePerf.reset()` between them:
   - **Typing, large.md, source mode** — hold a key / type naturally for
     ~30 s in the middle of the document. Read keystroke p50/p95.
   - **Typing, large.md, split mode** — same, both panes visible.
   - **Typing, main.tex, dual mode** — secondary pane showing a chapter.
   - **Switching** — cycle large.md ↔ main.tex ↔ a few notes ~10 times.
     Read `switch(read→paint)` p50/p95 and the per-command IPC table
     (`write_project_file`, `read_project_file`, `stat_project_file`,
     `refresh_project`, `git_status`).
   - **Idle** — leave the app for 60 s; check `refresh_project` /
     `git_status` totals and Activity Monitor CPU.
4. `__latticePerf.report()` dumps everything. Record numbers in the table
   below per stage.

## Results log

| Date | Change | Keystroke p95 (md source / split / tex dual) | Switch p50 | Notes |
| --- | --- | --- | --- | --- |
| _baseline_ | — | _fill in_ | _fill in_ | before optimization stages |

## Future directions (not yet scheduled)

- Editable-doc `content-visibility` experiment behind a dev flag, with
  selection/scroll behavior measured on WKWebView before any default flip.
- `App.tsx` state extraction (162 `useState` in one 8.6k-line component) and
  `DocumentCanvas` memoization (109 props, 26 inline lambdas at the call
  site).
- Split-mode publication: replace whole-document `setContent` with
  block-level splices; measure after the mdast-cache fix, which removed the
  worst multiplier.
- Long term: Obsidian-style single-editor live preview instead of two
  simultaneously mounted editors.
- Incremental BM25 workspace index (`updateWorkspaceSearchCorpus` exists but
  is unused); a filesystem watcher to replace the 2-second poll; CodeMirror
  remount-on-switch (`key={collabEditorKey}`) if switching still feels slow
  after the IPC fixes.
