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
cost), Tauri `listen()` handlers (9 non-test call sites today, all cleaned
up), file tree (already virtualized).

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
   - **Scrolling** — make a first downward pass through ordinary Preview,
     Split Preview, and a Paper, then repeat upward and downward.
     The report records frame p50/p95 and frames over 33 ms without reading
     layout from the probe itself.
4. `__latticePerf.report()` dumps everything. Record numbers in the table
   below per stage.

## Results log

**Nothing has been recorded here yet.** The table below is an empty template,
kept so there is an agreed shape to fill in — it is not a record of any
measurement, and the fixes described in this document shipped without one. If
you run the playbook, add a row; do not infer anything from the current
contents.

| Date | Change | Keystroke p95 (md source / split / tex dual) | Switch p50 | Notes |
| --- | --- | --- | --- | --- |
| _(template — no measurements recorded)_ | — | — | — | — |

## React Compiler status

`scripts/react-compiler-report.mjs` prints every compiler bailout in the hot
files; `src/platform/react-compiler-guard.test.ts` pins per-file ceilings so new
bailouts fail CI. As of August 2026: `editor-tabs.tsx` compiles fully, and
several syntax-level blockers (`??=`, inline `import()`, default-parameter `??`)
were cleared from `pdf-viewer.tsx`, `visual-markdown-editor.tsx`, and
`document-canvas.tsx`'s hooks.

Run the report before planning any of this — a bailout's *cause* decides the
recipe, and guessing from the file name has been wrong before. Remaining,
in order of value:

1. `App.tsx` — ~32 `try/finally` callback bodies plus a handful of throws
   inside try. Recipe: hoist each body to a module-level function taking a
   deps object, leave the `useCallback` as a thin arrow; per-file commits so
   regressions bisect. This is the single biggest render-cost win left.
2. Render-phase ref access in `visual-markdown-editor.tsx` — all 3 of its
   bailouts, in the L2302 editor core, on the typing hot path. They are the
   ref-passed-as-argument shape, so the fix is to wrap in a closure
   (`() => ref.current`) rather than to move a write. Cheaper wins of the same
   kind, each the *sole* bailout of its function: `app/use-panel-layout.ts`,
   `project/project-find-dialog.tsx`, `telemetry/app-updater.tsx`.
   Working model in the repo: `editor/codemirror-host.tsx:116-124` writes its
   refs in an every-commit `useLayoutEffect` and compiles with 0 bailouts.
   Note a wrong fix cannot land silently: moving the write to an effect while
   leaving a `useMemo` that reads `.current` is still rejected, so the bailout
   guard catches it.
3. `pdf-viewer.tsx` — 5 bailouts, all `tagged template with interpolations`
   (L673, L695, L1295, L1306, L1591), *not* ref writes. Its three ref sites are
   invisible to the compiler until these clear, so fixing them first unlocks
   nothing.
4. `DocumentCanvas` is skipped wholesale because its extension memos carry
   intentional `react-hooks/exhaustive-deps` disables (identity stability the
   compiler cannot express yet). Resolving this needs a design, not an edit.

Note that items 1 and 2 do not gate each other, and neither is load-bearing for
correctness: a render-phase ref access makes the compiler skip the *enclosing
function*, so these are lost optimisations, not latent bugs. The patterns that
do cause stale-render bugs are the ones the compiler cannot see — module-level
mutable state read during render, and objects mutated in place whose identity
never changes. Two such bugs shipped and were fixed in August 2026; see the
comment in `vitest.config.ts` for how the test suite now catches them.

## Library replacements (second round, August 2026)

Four dependency-level replacements landed after the fix rounds above:

- **`@uiw/react-codemirror` → `src/editor/codemirror-host.tsx`** (dependency
  removed). The wrapper serialized the whole document twice per keystroke
  (onChange + controlled-value comparison). The host reconciles the
  controlled value by reference — the string App stores is the one the host
  emitted — so the per-keystroke echo is a pointer check; full-document
  replacement runs only for genuinely external values, deferred while typing
  or composing (IME), annotated so it never echoes back.
- **harper.js (main-thread WASM) → `harper-core` in Rust**
  (`src-tauri/src/harper.rs`, `harper_lint` command; harper.js dependency
  removed). Same engine, same 2.7 line, but linting now runs in
  `spawn_blocking` — the WebView thread pays nothing, and the WKWebView
  Worker limitation that forced main-thread WASM is moot. Masking stays in
  JS so spans match the CodeMirror document; Rust converts harper's
  char-indexed spans to UTF-16 code units. The large-doc window from the
  earlier round still bounds IPC payload size.
- **2-second refresh poll → `notify` watcher** (`src-tauri/src/fs_watch.rs`,
  `watch_project` command, `project-fs-changed` event). Debounced FSEvents
  replace the poll; `.research/` churn is filtered, `.git/` events keep the
  source-control badge fresh. The frontend keeps a 30-second fallback poll
  for what watchers can miss.
- **Full BM25 rebuild → incremental corpus update**
  (`markdown-workspace-index.ts` now routes through
  `updateWorkspaceSearchCorpus`, which patches the shared index per changed
  document and rebuilds only for bulk changes).

Considered and deliberately kept: CodeMirror 6, Yjs, pdf.js, KaTeX,
lowlight, TipTap/ProseMirror (the split-mode cost is architectural, not the
library — see Future directions).

## Future directions (not yet scheduled)

- Editable-doc `content-visibility` experiment behind a dev flag, with
  selection/scroll behavior measured on WKWebView before any default flip.
- `App.tsx` state extraction — in progress rather than unscheduled. The file is
  ~9.8k lines with roughly 151 `useState`, and `src/app/use-collab-v2-session.ts`
  and `src/app/use-overleaf-workspace.ts` have already lifted ~1,800 lines of
  collab and Overleaf state out of it. Still open: `DocumentCanvas` memoization
  — 126 props and 26 inline lambdas at the call site in `App.tsx`, up from 109
  props when this was first measured.
- Split-mode publication: replace whole-document `setContent` with
  block-level splices; measure after the mdast-cache fix, which removed the
  worst multiplier.
- Long term: Obsidian-style single-editor live preview instead of two
  simultaneously mounted editors.
- CodeMirror remount-on-switch (`key={collabEditorKey}`) if switching still
  feels slow after the IPC fixes.

Two items that used to sit in this list have **shipped** and are described under
"Library replacements" above — do not re-plan them:

- The `notify` filesystem watcher replacing the 2-second poll
  (`src-tauri/src/fs_watch.rs`, the `watch_project` command, the
  `project-fs-changed` event).
- The incremental BM25 workspace index. `updateWorkspaceSearchCorpus` is no
  longer unused: `src/editor/markdown/markdown-workspace-index.ts:338` calls it on every
  corpus update.
