# Performance: how to measure, and what we found

The how-to comes first: the interaction benchmark CI gates on, the dev-app
probe, and the real-app lab ([`driving-the-app.md`](driving-the-app.md)). The
current status and open directions follow, and every dated investigation is
under [History](#history), oldest first.

## How to measure

Three tools, cheapest first:

- **`pnpm perf:bench`** (below) counts React and DOM work per interaction on
  the mock-backend page in headless Chrome. It is deterministic, CI gates on
  it, and it is the first tool to reach for.
- **The `lattice-perf` probe** ([Measurement playbook](#measurement-playbook))
  times typing, switching and scrolling in the dev app by hand.
- **The real-window lab** (`scripts/perf-lab.mjs`, described in
  [`driving-the-app.md`](driving-the-app.md)) measures frame rates, input
  latency and memory in the real WKWebView window with native input, and
  compares two builds. Use it for numbers a pull request quotes about the real
  app, so they stay comparable across pull requests.

### Interaction benchmark and CI gate

`pnpm perf:bench` measures Lattice's hot interactions deterministically, and CI
fails a pull request that makes one of them do more React or DOM work. It builds
`tools/perf-bench/` with the production config. That page is the real app, with
an in-memory backend holding the fixture project from `scripts/perf-fixture.mjs`
(the same content `gen-perf-fixture.mjs` writes to disk, at smaller sizes except `long.tex`). The
benchmark drives it in headless Chrome over the DevTools protocol with real
mouse, wheel and key events at a fixed cadence. Every step waits for the next
frame and a fixed pause, as a person would, so debounced work fires the same
number of times on a fast laptop and a slow runner. Each run ends when nothing
has committed or mutated for 1.5 s, longer than the app's slowest idle debounce.

What it counts, per interaction (`scripts/perf-bench/probe.js`, injected before
any page script):

| Count | Source |
| --- | --- |
| `commits` | React commits in which a component rendered or mounted, through a minimal React DevTools global hook |
| `renders` | components that rendered in those commits (the `PerformedWork` walk React DevTools uses) |
| `hooks` | hooks those renders ran |
| `recalcs`, `layouts` | Chromium's own `RecalcStyleCount` / `LayoutCount` (`Performance.getMetrics`) |
| `mutations` | `MutationObserver` records over the whole document |

A commit in which no component rendered is counted apart, as `idleCommits` in
`--json` and in the per-run line, never gated. It is a same-value state update
that React could not drop before rendering: React drops one only when the
component has no update left over from its last one, so whether it costs an
empty commit depends on how it interleaves with the component's real updates.
At startup, such commits in the PDF preview (between PDF.js page-render events)
and the source editor's scrollbar came or went from run to run: 24–26 commits
on one machine and 27–28 on the CI runner, with renders, hooks and update
origins identical in every run.

It also reports long tasks, layout shift by app region (titlebar, sidebar,
source editor, visual editor, PDF, diagnostics), and script, style, layout and
task durations. Those are wall-clock facts: reported, never gated.

Scenarios (`scripts/perf-bench/scenarios.mjs`):

| Scenario | Interaction |
| --- | --- |
| `startup` | load the app and open the fixture project with its PDF preview |
| `latex-typing` | 40 characters into a 60 KB chapter, PDF preview beside it |
| `long-tex-typing` | 24 characters into a 3.3 MB, 18k-line `.tex` file, PDF preview beside it |
| `markdown-source-typing` | 40 characters into the 400 KB Markdown document's source |
| `markdown-visual-typing` | 24 characters into it in the visual editor (one publication) |
| `file-switch` | tab switches between `main.tex`, `large.md`, a note and a chapter |
| `code-highlight` | switch to a document of 150 highlighted code blocks, type 20 characters in one (each after the 200 ms publication idle, so each publishes) |
| `pdf-open` | open a 200-page PDF from the navigator |
| `pdf-scroll`, `source-scroll`, `markdown-preview-scroll` | 40 wheel notches each |
| `dialog-open` | open the command palette over the 400 KB Markdown document in the visual editor and close it with Escape, 4 times |
| `pdf-zoom` | three 10-notch ctrl-wheel zoom gestures over the PDF preview, one notch per frame |
| `compile` | build, then expand the diagnostics and show the 4,000-line log |

#### Running it

- `pnpm perf:bench` measures and prints a table. `--check` also exits 1 when a
  gated count exceeds its ceiling; that is what CI runs (the `perf-bench` job, and
  `mise run perf-bench` locally).
- `--only a,b` limits scenarios. `--runs N` repeats each scenario and gates
  each count at its fewest across the runs, because noise only ever adds work
  and each count's noise is its own. The report-only counts shown are those of
  the run with the fewest gated counts in total, and do not affect the choice.
  The default is 2.
- `--dev` uses the Vite dev server so component names stay readable. Its counts
  match production's, but only production runs are gated or written.
- `--json FILE` writes every run with `topComponents` (who rendered) and
  `updateOrigins`. An update origin is a component whose own state or store
  snapshot changed, such as `App#26`, App's 27th hook. It shows what started an
  update, not just what re-rendered.
- `--profile DIR` saves a CPU profile of each scenario to open in DevTools.
- `--url URL` measures an already running app (for example the browser-hosted
  real app) with the same probe, without ceilings.
- `--engine webkit` runs the scenarios in Playwright's WebKit (install it once
  with `pnpm exec playwright-core install webkit`) against
  `scripts/perf-bench/budgets-webkit.json`; CI runs it too (the
  `perf-bench-webkit` job, on macOS). Release builds render in WKWebView, and
  WebKit's cost per element styled or laid out is several times Chromium's, so
  a change that grows the DOM is caught in the engine users run. WebKit has no
  style or layout counters: its `recalcs` and `layouts` are blank and CPU
  profiles are Chromium-only.
- `--layout` runs no benchmark: it checks geometry jsdom cannot lay out
  (`scripts/perf-bench/layout-checks.mjs`), each check on a fresh page at its
  own viewport and query, and exits 1 with a screenshot when one fails. CI runs
  it in both engines after `--check`. `paper-header-long-doi` opens a Paper
  with a very long DOI in a ~500px reader header and fails when the PDF action
  overlaps the source link or takes a click on its arrow.

#### Ceilings and the ratchet

`scripts/perf-bench/budgets.json` holds a ceiling per scenario and gated
count. A ceiling sits 20% (at least 5) above the measurement that set it.

Only counts that repeat from run to run are gated; a flaky gate is worse than
none. The rest depend on frame timing, so the same build measures them
differently on each run and more so on a busy machine. They are still measured
and printed, and `--json` keeps them, but no ceiling holds them
(`REPORT_ONLY` and `REPORT_ONLY_BY_SCENARIO` in `scripts/perf-bench/budgets.mjs`):

| Scenario | Gated | Report-only | Why report-only |
| --- | --- | --- | --- |
| every scenario | | `recalcs`, `layouts` | Two DOM changes landing in one frame share a pass. One build measured 120–207 `pdf-scroll` recalculations across runs, more under load. |
| `pdf-scroll`, `source-scroll` | `commits`, `renders`, `hooks` | `mutations` | A Lattice scrollbar fades out 180 ms after the last scroll event, and how many of 40 notches that falls between depends on the machine (`pdf-scroll`: 936–1,028). The fade is written to the DOM, not React state, so it adds no commits. |
| `markdown-preview-scroll` | | `commits`, `renders`, `hooks`, `mutations` | The same scrollbar fade, and Base UI's scroll area (the visual editor's scroller) re-renders when a scroll burst starts and 500 ms after it ends, in React state. How many bursts 40 notches make depends on stalls (139–259 renders on one machine, 225 on the CI runner). |
| `pdf-zoom` | `commits`, `renders`, `mutations` | `hooks` | Each gesture's rescale re-renders the pages in view, and their render and text-layer events reach the PDF preview in 4–7 commits depending on timing, each about 76 hooks: 457–687 across runs. |
| `latex-typing`, `long-tex-typing` | `renders`, `hooks`, `mutations` | `commits` | A keystroke's updates commit together or apart depending on timing: 81–85 commits on one machine, 101 on the CI runner, with renders within 4%. |
| `markdown-visual-typing` | `commits`, `mutations` | `renders`, `hooks` | The 24 keystrokes publish in one or two batches depending on timing, and each batch re-renders the editor chrome (634–1,243 renders). |
| `code-highlight` | `commits`, `renders`, `hooks` | `mutations` | 2,510–2,957 across runs of one build. |
| all others | `commits`, `renders`, `hooks`, `mutations` | | |

The gated counts repeat exactly or move by a commit or two when an async load
lands before or after a step, well inside the headroom. A regression worth
catching multiplies a count.

- `pnpm perf:bench --ratchet` lowers every ceiling the counts now beat, and
  never raises one. Run it after a speedup lands and commit the new
  `budgets.json`. `--check` lists the ceilings that have room to ratchet.
- Raising a ceiling is a hand edit with a reason in the pull request.
  `--update` rewrites every ceiling from one run; review that diff like code.
- A new scenario gets its ceilings on its first full run.

### Measurement playbook

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
   - **Typing, main.tex, split mode** — source beside the PDF.
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
4. `__latticePerf.report()` dumps everything. Record the numbers in the
   pull request.

## Status and directions

### React Compiler status

`scripts/react-compiler-report.mjs` prints every compiler bailout in the hot
files; `src/platform/react-compiler-guard.test.ts` pins per-file ceilings so new
bailouts fail CI. As of August 2026: the since-removed `editor-tabs.tsx` compiled fully, and
several syntax-level blockers (`??=`, inline `import()`, default-parameter `??`)
were cleared from `pdf-viewer.tsx`, the since-removed `visual-markdown-editor.tsx`,
and `document-canvas.tsx`'s hooks. Its replacement,
`editor/markdown/engine/lattice-visual-editor.tsx`, is pinned at 0 bailouts.

Run the report before planning any of this — a bailout's *cause* decides the
recipe, and guessing from the file name has been wrong before. Remaining,
in order of value:

1. `App.tsx` — its `try/finally` bodies and inline `import()`s left with the
   hooks extracted into `src/app/`; what remains is one preserve-manual-memo
   report per `useCallback`/`useMemo` whose dependency list the compiler
   cannot preserve. Recipe: let the compiler own the memoization (drop the
   manual wrapper or narrow its dependencies); per-file commits so
   regressions bisect. This is the single biggest render-cost win left.
2. Render-phase ref access, each the *sole* bailout of its function:
   `project/project-find-dialog.tsx`,
   `telemetry/app-updater.tsx`. Where a ref is passed as an argument during
   render, the fix is to wrap it in a closure (`() => ref.current`) rather
   than to move a write.
   Working model in the repo: `editor/codemirror-host.tsx:116-124` writes its
   refs in an every-commit `useLayoutEffect` and compiles with 0 bailouts.
   Note a wrong fix cannot land silently: moving the write to an effect while
   leaving a `useMemo` that reads `.current` is still rejected, so the bailout
   guard catches it.
3. The PDF viewer — split into `pdf-viewer.tsx` and the `use-pdf-*` hooks, it
   is down from 5 bailouts to 2 and `PdfPreview` itself compiles: a `tagged
   template with interpolations` in `use-pdf-document.ts` and one preserved
   memo in `use-pdf-view.ts`. Neither is a ref write.
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

### Future directions (not yet scheduled)

- Opening a long Markdown document is now mostly reading it: the engine
  parses the whole file with micromark on the main thread on every open
  (about 370 ms in Chromium and 430 ms in WebKit for 2 MB). Caching the read
  by text, or reading in a worker, is what remains.
- `App.tsx` state extraction — in progress rather than unscheduled; its current
  size and extraction status live in `docs/codebase-map.md` §6. Still open: `DocumentCanvas` memoization
  — 126 props and 26 inline lambdas at the call site in `App.tsx`, up from 109
  props when this was first measured.
- Split-mode publication: replace whole-document `setContent` with
  block-level splices; measure after the mdast-cache fix, which removed the
  worst multiplier.
- Long term: Obsidian-style single-editor live preview instead of two
  simultaneously mounted editors.
- CodeMirror remount-on-switch (`key={editorKey}`) if switching still
  feels slow after the IPC fixes.

Two items that used to sit in this list have **shipped** and are described under
"Library replacements" under History — do not re-plan them:

- The `notify` filesystem watcher replacing the 2-second poll
  (`src-tauri/src/fs_watch.rs`, the `watch_project` command, the
  `project-fs-changed` event).
- The incremental BM25 workspace index (`PageSearchIndex` in
  `src/project/workspace-search.ts`, updated on every corpus publication by
  `src/editor/markdown/markdown-workspace-index.ts`).

### What smooth editors do (industry survey)

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

## History

Dated investigations, oldest first. Numbers here are what was measured at
the time; re-measure before quoting one.

### What was actually slow here (August 2026)

Written after the August 2026 investigation into "long Markdown documents lag
while editing, and file switching is slow". Three codebase surveys plus an
industry comparison produced the findings below; the fixes land in stages,
each measured with the harness in this document.

Editing long Markdown:

| Cause | Where |
| --- | --- |
| Visual editor renders the whole document into the DOM; the upstream `content-visibility` chunking plugin was never vendored (CSS was). A long document is now drawn only near the viewport (see "Viewport rendering for long documents") | `editor-globals.css` `.ok-chunk-wrapper`, upstream `chunk-wrapper-decoration.ts` (the vendored editor, removed in phase 3 of the visual editor rebuild) |
| `HeadingAnchors` rebuilt a whole-document DecorationSet on every view update, including caret-only moves | `open-knowledge-app/editor/extensions/heading-anchors.ts` (the vendored editor, since removed) |
| Every keystroke rebuilt `liveSourceMap` and re-ran four whole-project parses (macros, graphics roots, katex macros, appendix) even for `.md` buffers | `App.tsx` around `liveSourceMap` |
| React Compiler silently bailed out of `App`, `DocumentCanvas`, `VisualMarkdownEditor`, `EditorTabs`, `ContinuousPdfPage` (try/finally, `x++` in lambdas, inline `import()`), so none of the hot tree was auto-memoized (`VisualMarkdownEditor` and `EditorTabs` have since been removed) | `scripts/react-compiler-report.mjs` finds these |
| Secondary CodeMirror reconfigured all extensions every keystroke in dual/split mode | `document-canvas.tsx` `secondaryEditorExtensions` (the second editor has since been removed) |
| Comment decorations serialized the whole doc before checking whether any comments exist | `editor-comments.ts` |
| Harper linted the whole document on the main thread every 350 ms of typing | `latex-editor.ts`, `harper-spellcheck.ts` |
| Single-slot mdast cache thrashed by the publication probe: 3 full parses where 1 suffices | `visual-markdown-editor.tsx` (the vendored editor, since removed) |

Slow file switching:

| Cause | Where |
| --- | --- |
| 2-second poll re-read the full bytes of every project file (`scan_files` → `classify_regular_file`) and spawned ~6 git subprocesses per tick | `project.rs`, `git.rs` |
| Every save parsed up to 100 history records (each embedding full before/after contents) to find the newest; dirty switches await the save | `project.rs` `latest_history_record` |
| Cursor/scroll restore was gated behind an unrelated `stat` round trip; save and read ran serially | `use-open-documents.ts` `loadFile` (then in `App.tsx`) |
| `read_file` read every file twice (classification pass + content pass) | `project.rs` |

Ruled out: agent streaming (cross-origin iframe + postMessage, zero React
cost), Tauri `listen()` handlers (9 non-test call sites today, all cleaned
up), file tree (already virtualized).

A constraint to respect: **editable surfaces do not use
`content-visibility: auto`** — deferred materialization destabilizes WebKit
selection anchoring, and it measured worse in both engines (fast scrolling a
2 MB document: 8 fps in WebKit, 5 fps in Chromium). A long document is drawn
only near the viewport by the engine's block window instead
(`editor/markdown/engine/block-window.ts`, see "Viewport rendering for long
documents" below), and a large read-only document opens in the passive view
(`editor/markdown/engine/passive-view.tsx`).

### Library replacements (second round, August 2026)

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
- **Full BM25 rebuild → incremental page index**
  (`markdown-workspace-index.ts` feeds `PageSearchIndex.update` in
  `src/project/workspace-search.ts`, which indexes page names only and reuses
  the analysis of every page whose name is unchanged).

Considered and deliberately kept: CodeMirror 6, Yjs, pdf.js, KaTeX,
lowlight, TipTap/ProseMirror (the split-mode cost is architectural, not the
library — see Future directions).

### Long-session degradation (September 2026)

The report: after using the app for a while, scrolling lags and sometimes
sticks. The causes below were each found in heap snapshots and CPU metrics
from the real app, and each fix has a regression test beside it.

**How it was measured.** WKWebView has no automation protocol, so the
measurements used the app's own browser mode: the debug Rust backend, a
production frontend build, and headless Chromium at
`http://localhost:1420/?latticeBrowser=1`. A CDP script sent real mouse,
wheel and keyboard input and ran on the perf fixture from a fresh project.
One cycle was: edit a chapter, rebuild the 386-page book and scroll the PDF;
scroll the chapter source; open `large.md` and scroll the split preview, the
source and the full preview; open three notes; return to `main.tex` and
scroll the PDF. After each cycle it forced GC and read the JS heap, DOM nodes
and listeners. For every wheel burst it recorded rAF cadence and
renderer main-thread CPU time (`Performance.getMetrics` `ThreadTime`, which
other load on the machine barely affects). WebKit-only behaviour was checked
in Playwright's WebKit 26.6 against the same backend.

| Cause | Evidence | Fix |
| --- | --- | --- |
| Replaced PDF.js viewers were never detached | 3,860 detached PDF pages (ten viewers) after five cycles, retained by each viewer's document `copy` listener and PDF.js's static `TextLayerBuilder` map; PDF scroll CPU per burst grew 438 → 1,752 ms | `destroyViewerRecord` calls `PDFViewer.setDocument(null)` and zeroes canvases (`pdf/pdf-slick.ts`) |
| Frozen table-header scroll animations outlived their cells | Scroll-driven `Animation`s stay in effect while the scroller is connected. Each file switch kept the replaced document alive through its header cells: +6.6k DOM nodes and +3.2 MB heap per `large.md` ⇄ note switch, with split-preview fps falling as stale animations piled up | the plugin view tracks animated cells and releases dropped ones (`open-knowledge-app/editor/extensions/frozen-table-headers.ts`, in the vendored editor, since removed) |
| DocumentCanvas render scopes chained replaced editors | DocumentCanvas is not compiled, so every closure captures its render scope. CodeMirror keeps extension closures for the view's life, and the scope held the previous `EditorView` and preview element in state, so each switch retained the previous editor and its whole document | that state holds `WeakRef`s (`canvas/document-canvas.tsx`) |
| Base UI ScrollArea restyled the whole document on every scroll event in WebKit | Base UI writes four `--scroll-area-overflow-*` properties on the viewport per scroll event and registers them as non-inherited everywhere except WebKit. Same page, split preview of `large.md`: 2.1–2.2 fps (p95 frame ≈ 1.09 s) as shipped; 14.8–15.5 fps (p95 ≈ 0.13 s) with the properties registered | registered in `components/ui/scroll-area.tsx` |

Five-cycle long session, fresh app each run. Heap, nodes and listeners are
read after GC on `main.tex`; the other rows show cycle 0 → cycle 4:

| | Before | After |
| --- | --- | --- |
| JS heap after cycle 4 | 88.1 MB (+9.2 MB/cycle) | 62.9 MB (+1.4 MB in the last cycle) |
| DOM nodes after cycle 4 | 102,556 | 3,856 |
| JS event listeners after cycle 4 | 2,806 | 931 |
| Heap snapshot (self size / detached nodes) | 207 MB / 84,232 | 50 MB / 919 |
| PDF scroll, main-thread CPU per burst | 438 → 1,752 ms | 453 → 413 ms |
| Chapter source scroll, CPU per burst | 234 → 682 ms | 209 → 203 ms |
| Markdown preview scroll, fps | 54.7 → 42.7 | 55.2 → 57.5 |
| Markdown source scroll, fps | 56.1 → 50.1 | 57.0 → 58.5 |

Ruled out: Rust-side growth (no backend collection grows with opening,
editing, compiling or scrolling; the app process RSS varied without a trend
between runs), Tauri `listen()` and observer cleanup (all paired), and the
file tree. Not reproduced: Overleaf sync (it needs an account) and the agent
panel (it needs the Synara sidecar, which these builds stubbed out).

Still open, and bounded rather than growing:
- Leaving `large.md` still keeps one copy of its visual-editor DOM, about 25k
  nodes. React's previous fiber state holds it until the editor next renders.
- Every TipTap React node view is a portal container, and React attaches
  about 139 listeners to each. `large.md` therefore carries around 75k
  listeners while it is open.

### Interaction benchmark findings (September 2026)

The techniques came from Anthropic's write-up on making claude.ai faster. Each
fix below was found by the benchmark or a trace and checked by it afterwards.
The table compares main before this work (at #48, measured with this
benchmark) against it after. Counts are per interaction on the production
build, best of two runs; `recalcs` and `layouts` are reported only, not gated.

| Interaction | commits | renders | hooks | recalcs | layouts | mutations | long tasks | task ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| startup (per load) | 23 → 21 | 2,111 → 1,694 | 12,573 → 10,710 | 82 → 83 | 59 → 57 | 1,468 → 1,454 | 0 → 0 | 403 → 384 |
| LaTeX typing (per key, 40) | 3.1 → 2.0 | 710 → 196 | 5,034 → 1,575 | 12.9 → 9.9 | 5.1 → 5.1 | 25.3 → 19.3 | 0 → 0 | 725 → 478 |
| Markdown source typing (per key, 40) | 2.1 → 1.1 | 309 → 143 | 2,783 → 1,378 | 6.7 → 6.7 | 3.1 → 3.1 | 7.4 → 7.4 | 0 → 0 | 569 → 499 |
| Markdown visual typing (per key, 24) | 1.4 → 1.2 | 73 → 26 | 609 → 215 | 1.8 → 1.5 | 1.2 → 1.1 | 4.7 → 4.3 | 27 → 2 | 4,732 → 625 |
| file switch (per switch, 4) | 15.0 → 13.8 | 2,865 → 2,458 | 14,860 → 12,550 | 99 → 72 | 51 → 24.8 | 2,932 → 2,929 | 3 → 3 | 1,045 → 761 |
| code blocks (per action, 21) | 5.4 → 4.3 | 1,256 → 894 | 9,857 → 5,942 | 14.6 → 6.4 | 10.0 → 3.0 | 242 → 241 | 41 → 1 | 6,329 → 1,786 |
| open a 200-page PDF | 13 → 14 | 1,009 → 714 | 4,890 → 4,058 | 64 → 64 | 35 → 36 | 1,147 → 1,131 | 0 → 0 | 118 → 118 |
| PDF scroll (per notch, 40) | 0.8 → 0.7 | 51.5 → 28.8 | 329 → 262 | 2.8 → 2.4 | 1.0 → 1.0 | 23.4 → 22.4 | 0 → 0 | 276 → 288 |
| source scroll (per notch, 40) | 0.1 → 0.0 | 0.1 → 0.0 | 0.5 → 0.2 | 1.7 → 1.7 | 0.3 → 0.3 | 17.7 → 17.7 | 0 → 0 | 97 → 161 |
| Markdown preview scroll (per notch, 40) | 0.3 → 0.3 | 3.5 → 3.5 | 24.9 → 24.9 | 3.5 → 3.6 | 0 → 0 | 4.8 → 4.8 | 0 → 0 | 588 → 400 |
| compile and show the log | 8 → 8 | 1,231 → 1,041 | 8,423 → 7,869 | 82 → 81 | 9 → 9 | 133 → 125 | 1 → 0 | 208 → 187 |

Long tasks and task time come from the same runs on one Apple-silicon laptop.
They are wall-clock facts, so only the large changes carry meaning: visual-editor
typing and the code-block document stopped producing long tasks. Measured
against the older main this work started from (before the #43 viewer split),
PDF scrolling also fell from 149 renders per notch to 35, and LaTeX typing from
1,143 renders per keystroke.

Stability: `pnpm perf:bench --check` passed 10 runs out of 10 in a row on the
final branch, the last one with vitest running alongside.

| Cause | Evidence | Fix |
| --- | --- | --- |
| The visual editor parsed every block of the document after each pause in typing. The caret report mapped the caret through `exactVisualSourceRanges`, which parsed each top-level block on its own (about 1,000 parses at 400 KB). When that failed on the edited block, it serialized the whole document only for `reportVisualCaret` to discard the result. | CPU profile over 40 keystrokes: 10.1 s of main-thread tasks, 42 long tasks. `parseVisualMarkdown` took 8.2 s of that, inside `sourceOffsetForProseMirrorPosition` (7.5 s), and `renderedRootCount` took 5.6 s. | Memoize root counts per block source and ranges per text; skip the whole-document fallback while edits wait for publication; reuse the cached parse in `restoreUnchangedBlocks` (`editor/markdown/visual-source-map.ts`, `visual-markdown-serialization.ts`, `visual-markdown-editor.tsx`; the vendored editor, since removed) |
| Each LaTeX keystroke rendered all of App three times. CodeMirror reports a `pending` completion query for every typed letter and then `null`, and each edge flipped `editorCompletionActive` in App. `useDeferredValue(source)` for the TODO badge re-rendered App a third time. | Update origins: `App#84` (completion state) changed 80 times in 40 keystrokes. About 380 components rendered per App commit. | `pending` keeps the last answer (`canvas/document-canvas.tsx`). The TODO rescan runs in the keystroke's own render. |
| The TODO rescan split the document into lines and lowercased every line on each keystroke. | Visible in the deferred render above | One case-insensitive search finds the candidate lines first (`project/todo-scavenger.ts`) |
| The React Compiler skipped `PdfPreview`, because PDFSlick's property setters in its callbacks and two Lingui tagged templates blocked it. Uncompiled, `PdfPreview` re-rendered its toolbar and about 11 tooltips whenever the canvas did, including on every editor keystroke. | 231 of the 1,143 renders per LaTeX keystroke. 149 renders per PDF scroll notch. | Setters moved to module helpers (`pdf/pdf-slick.ts`), descriptor-form messages (`pdf/pdf-viewer.tsx`). The compiler guard pins the file at 0 bailouts. |
| Every TipTap React node view forced a synchronous style and layout pass as its content attached: `captureDOMSelection` reads `selection.rangeCount`. | Trace of opening a document with 150 code blocks: 150 forced style recalculations and 150 forced layouts, all with the stack `captureDOMSelection < nodeViewContentRef`. 238 recalculations in total. | The `@tiptap/react` patch reads the selection only when the content sits in the focused element, where a caret can be. The same open then took 91 recalculations. |
| Frozen table headers and table insert controls measured each table right after writing to the previous one. | Trace of switching to `large.md` (40 tables): 35 forced passes from `computeAndApplyFrozenHeaders` and 36 from floating-ui `autoUpdate` in `addOverlay` | Measure every table, then write (`frozen-table-headers.ts`, since removed). Mount every overlay, then start positioning (`table-insert-controls.ts`, since removed). |
| The heading rail queried every heading once per rail item, which is quadratic, and it re-measures after every edit. | 1,455 ms of `querySelectorAll` self time opening the 150-section code document | One query per measure (`editor/markdown/document-heading-rail.tsx`) |
| The titlebar's tab strip, the navigator's protected paths and the build pipeline object were fresh on every App render. | Titlebar subtree re-rendered about 80 components per keystroke | Memoized in `App.tsx` and `app/use-build-pipeline.ts` |
| The PDF toolbar's page buttons re-rendered on every page change while scrolling, and the overlay scrollbars revealed themselves through React state on every scroll burst. | Commits and renders per PDF scroll notch; scroll-scenario counts that moved between runs | Page buttons keep stable props (`pdf/pdf-viewer.tsx`); the scrollbar reveal is a DOM attribute, not a React commit (`components/ui/overlay-scrollbar.tsx`, `scrollbar-track.ts`, `external-scrollbar.tsx`, `canvas/codemirror-scrollbar.tsx`) |

Checked and deliberately not applied:

- **One-byte strings before highlighting.** A code block sliced from a document
  that contains an em dash is a two-byte string in both V8 and JavaScriptCore.
  For 150 ASCII blocks run through lowlight, highlighting the slices against
  flattened copies took 32.0 vs 31.0 ms in Playwright WebKit and 24.2 vs 22.9 ms
  in Chromium. Not worth a copy per block.
- **Expensive selectors under WebKit.** Removing all 64 `:has()` rules did not
  reduce the style and layout forced at the start of each frame while typing in
  the visual editor on `large.md` in Playwright WebKit (133 ms vs 166 ms over 64
  keystrokes, which is noise). Removing the `[data-theme]` descendant variants,
  the `:hover` rules or the `:where(.tiptap-editor, …)` preflight scope did not
  help either. In Chromium, dropping them saved nothing on opening the
  code-block document (105–112 ms of recalculation vs 103–108 ms). None of these
  are a `:root:has()`-style rule, and none were changed.
- **Tokenizing in a worker.** Lowlight already re-highlights only the code blocks
  a transaction touched. A trace of typing five characters into a code block
  recalculated 36 elements in total.
- **Deferring data until after first paint, and layout shift.** Startup
  cumulative layout shift is 0.0001 across all regions. The Markdown search
  index costs about 12 ms of script at startup in the benchmark.
- **An instant static shell.** The production bench renders the app root at
  about 90 ms and paints first content at about 108 ms, so a static shell has
  under a tenth of a second to win.
- **Prefetch on hover** already exists (`usePreviewPrewarm`). **V8 code
  caching** does not apply to WebKit.

Still open: App itself is not compiled (17 bailouts, see "React Compiler status" above) and renders
about 200 components per keystroke. A PDF page change re-renders App because
the agent context reads the page number. Radix tooltips and popovers render
twice as they mount, which a document full of node views multiplies.

### Typing in a long LaTeX file (October 2026)

A keystroke in a 3.3 MB, 18k-line `.tex` file took about 35 ms in Chromium
and 50 ms in WebKit, against 10–14 ms in a 60 KB chapter. The cost was the same
in both engines: work in the keystroke's own render that read the whole
document. A CPU profile of `long-tex-typing` found it:

| Cause | Per keystroke (Chromium) | Fix |
| --- | --- | --- |
| The status bar's raw word count matched every word of the document into an array | 9 ms | Reads the settled source (below); counts matches without collecting them (`editor/latex/latex-edits.ts`) |
| The math preview paired every math delimiter from the start of the document, and kept scanning past the caret | 7 ms | Searches only the caret's paragraph, since TeX math cannot cross a blank line, and stops at the caret (`editor/latex/math-region.ts`). Command completion reads that paragraph from the CodeMirror document instead of joining the whole document into one string. |
| The TODO rescan of the open buffer | 4 ms | Reads the settled source |
| The appendix marker split every line of every source | 3 ms | Reads the settled source; skips sources without `\appendix` (`editor/latex/latex-text.ts`) |
| Labels, `\newcommand`s, graphics paths, KaTeX macros, the project outline and the breadcrumb, each a parse of the whole buffer | about 7 ms | Read the settled source |
| Go to line counted the document's lines on every App render | 0.4 ms | Counted only while the dialog is open (`app/app-search-dialogs.tsx`) |

The settled source (`app/use-settled-source.ts`) is the editor's text as of
the last pause in typing: after 500 ms without an edit, or at most every 5 s
of continuous typing. Only buffers of 100,000 characters or more use it. The
editor itself stays live; the counts, TODOs, outline, breadcrumb, labels and
macros catch up once per pause instead of once per keystroke. Smaller buffers
read live, as before.

Keystroke latency (from `keydown`, captured, to the end of the next frame) on
the benchmark page in Playwright 1.63's headless Chromium
and WebKit, 60 keystrokes, median of three runs, p50 / p95 in ms:

| Document | Chromium before | Chromium after | WebKit before | WebKit after |
| --- | --- | --- | --- | --- |
| `long.tex`, 3.3 MB | 35.7 / 39.9 | 14.5 / 22.3 | 51.0 / 59.0 | 9.0 / 12.0 |
| `ch01.tex`, 60 KB | 14.3 / 22.0 | 13.7 / 20.8 | 10.0 / 12.0 | 8.0 / 10.0 |

Headless Chromium does not go below about 13 ms here even for the small
chapter. The catch-up after a pause is one frame of 34–41 ms in WebKit.

In the benchmark, `long-tex-typing` spent 966 ms of main-thread tasks over 24
keystrokes before and 367 ms after (best of two runs each). Renders rose from
104 to 107 per keystroke: App renders once more when the long buffer's
derivations catch up. Mutations fell from 7.7 to 6.8 per keystroke because the
status bar no longer rewrites its counts on every key.

Still O(document) per keystroke:

- The source editor hands App the whole text as one string
  (`doc.toString()`), about 0.1 ms and 3 MB of garbage per keystroke at this
  size.
- With TexLab installed, completion sends the whole text with every
  keystroke in a word (`texlab_completion`). The benchmark's mock backend does
  not model that IPC.

### WebKit frame rate and dialogs (October 2026)

Two WebKit-only costs found while comparing the bundled Chromium with the
system WKWebView:

| Cause | Evidence | Fix |
| --- | --- | --- |
| WKWebView ships the WebKit feature `PreferPageRenderingUpdatesNear60FPSEnabled` on, so page rendering updates (rAF, scroll-driven work, main-thread animation) ran at 60 Hz on a 120 Hz display | The app's native WKWebView window (a lab build), rAF over 10 s: 60.0–60.2 fps (17 ms median frame) as shipped, 119.8–120.1 fps (8 ms) with the feature off | every workspace window turns it off through the `WKPreferences` feature SPI, after checking both selectors exist (`render_at_display_refresh_rate` in `src-tauri/src/macos_window.rs`) |
| Radix's modal dialog mode restyles the whole document on open: `pointer-events: none` on `body`, an injected scroll-lock stylesheet and `aria-hidden` on every sibling | Command palette open → painted over a 2 MB `large.md` in the visual editor (45k elements; the perf-bench page with `largeMarkdownBytes=2000000`, not the 400 KB benchmark fixture), median of 18 opens: Playwright WebKit 26.6 1,984 ms, Chromium 261 ms | `ModalDialog` is non-modal with its own backdrop, a trapped `FocusScope` and `aria-modal` (`components/ui/modal-dialog.tsx`): WebKit 106 ms, Chromium 241 ms. The `dialog-open` benchmark scenario guards it. |

### Viewport rendering for long documents (October 2026)

The WebKit-versus-Chromium measurement found long visual Markdown documents
slow in both engines, and far slower in WebKit, for one reason: the visual
editor drew every block. The playbook's 2 MB `large.md` was 43,983 elements,
and everything that touched style or layout while it was open paid for them:
opening it, scrolling it, typing in it, a dialog over it.

What changed:

- **The block window** (`editor/markdown/engine/block-window.ts`, spec
  R-PERF-3). A document of at least 250 top-level blocks draws only the blocks
  within one and a half viewport heights of the view, plus the selection's
  blocks and the ones either side of its head. Every other top-level block is
  an empty placeholder sized from its last measurement, or estimated from its
  text until it has been drawn. The window moves before the edge of what is
  drawn reaches the view, and the block on screen is held where it was while
  the blocks around it change size. The document is never windowed: editing,
  selection, IME, find, copy and publication work on all of it.
- **Two global selectors that made each insertion restyle every block after
  it.** A positional pseudo-class on a subject the whole page has is tried on
  every element of that kind, and marks each one's parent as affected by
  positional rules, so inserting a child restyles all its following siblings.
  The culprits were `p:first-of-type` in the PDF.js viewer stylesheet that
  `@pdfslick/core` bundles (patched to `:first-child`) and
  `.split-canvas > :nth-child(…)` in `editor-workspace.css` (now
  `:first-child` and `:last-child`). Drawing one block into a document of 5,000
  placeholders cost 35 ms of style in WebKit, in Preview and in Split, and
  14 ms in Chromium; it now costs 1–2 ms in WebKit and 1 ms in Chromium. Keep
  `:nth-*`, `:*-of-type` and `~` off any subject that can match editor
  content.

Tried and not kept: `content-visibility: auto` (see the constraint above),
and one spacer per run of placeholders, as CodeMirror draws its gaps. Spacers
cut WebKit's layout per window move only from about 68 ms to 50 ms, since the
selectors above were the cost, not the boxes; with the selectors fixed,
placeholders cost nothing measurable, and they keep the geometry the split
view's scroll sync, the section rail and the block controls read. Rich
rendering as CodeMirror decorations (Obsidian, Overleaf) was not needed.

How it was measured: the perf-bench page (the real app over the in-memory
backend) at the playbook size (`largeMarkdownBytes=2000000`: about 5,000
blocks), in headless Chromium and WebKit from Playwright 1.63, at 1440×900 and
2×, with the WebKit-versus-Chromium report's metrics: frame cadence from
`requestAnimationFrame` while 240 px wheel notches arrive every 16 ms for
3 s, keydown to the next frame (rAF plus a macrotask) over 32 keys, and
quiet in DOM mutations for "settled". Medians of three runs. Headless
rendering runs at 60 Hz, so 60 fps is the ceiling here. Playwright's WebKit is
not the system WKWebView: it lacks `margin-trim`, so Tailwind's
`@layer properties` fallback (every custom property set on every element)
applies to it and not to the app on macOS; its numbers are pessimistic.

| 2 MB `large.md`, visual editor | Chromium before | after | WebKit before | after |
| --- | --- | --- | --- | --- |
| Visual editor elements | 43,983 | 4,743 | 43,983 | 4,743 |
| Open → first content painted (ms) | 1,409 | 509 | 3,619 | 867 |
| Open → settled (ms) | 1,833 | 860 | 4,677 | 1,098 |
| Fast scroll: fps; frames over 50 ms; longest (ms) | 27.1; 10; 57 | 59.7; 0; 31 | 21.6; 22; 95 | 59.1; 0; 35 |
| Distance scrolled in those 3 s (px) | 6,960 | 12,480 | 5,280 | 21,120 |
| Frames with a blank (undrawn) block on screen | 0 | 0 | 0 | 0 |
| Typing, keydown → next frame p50 / p95 (ms) | 25.8 / 39.9 | 14.4 / 17.6 | 63 / 83 | 19 / 21 |
| Command palette over the document (ms) | 229 | 47 | 2,027 | 185 |

The 4,743 elements are the drawn window and one empty box per block. What
remains of opening is mostly reading the file (see Future directions).

`pnpm perf:bench` (400 KB `large.md`), per unit, before → after: a file switch
renders 1,670 → 685 components with 8,692 → 6,358 hooks and 1,733 → 1,414
mutations, in 729 → 431 ms of tasks; the code-block document renders 782 → 365
with 5,257 → 4,330 hooks, in 825 → 591 ms. No other count moved, and the
ceilings were ratcheted. One wall-clock change: Chromium spell-checks an
editable root in idle time ("cold mode"), which it did not do while the
visual editor held a whole long document. It now checks the drawn window, as
it always has a short document, in idle slices of up to 50 ms after the drawn
text changes; `markdown-visual-typing` reports them as long tasks (0 → 4–7).

### WebKit parity: panel drags, long PDFs, opening long sources (October 2026)

The parity gate for dropping the bundled Chromium (the WebKit-versus-Chromium
report's harness, re-run on main) still failed after the fixes above, mostly in
four places. The causes, all in our code or in how it drives PDF.js:

| Cause | Evidence | Fix |
| --- | --- | --- |
| The PDF preview was a CSS size container (`container: pdf-preview / inline-size`) for one toolbar query. When a query container's width changes, WebKit restyles everything inside it, so every frame of a panel-divider drag restyled each page box of the PDF | Dragging the divider beside a 386-page PDF: 82 fps, 123 with the container removed (Chromium 119) | the container is the toolbar's own frame (`.pdf-toolbar-frame`); the paper reader's moved from the whole reader to its header |
| A long visual document laid out each of its thousands of placeholders, and repainted its pane, on every frame of a divider drag | With the 2 MB `large.md` open: 37 fps and 800 ms frames in WebKit, 111 fps in Chromium | content that opts in with `data-holds-width` keeps its width while Trellis marks the workspace `data-resizing`, and rewraps once on release (`trellis/trellis-hold-width.ts`); the block window opts in while it is active. Held content is marked `data-width-held`, and the section rail keeps its shown or hidden state while it is, since toggling the rail changes the surface's padding and lays the placeholders out again (`editor/markdown/document-heading-rail.tsx`) |
| Every PDF page was `position: relative`, so in WebKit each one was a render layer, and every zoom or fling frame of a 1,930-page PDF updated all of them | Ctrl-wheel zoom of that PDF: 53 → 75 fps; fling 107 → 119 fps; jump to 70 % 78 → 59 ms | only a page holding layers (or SyncTeX's highlight, or its spinner) is positioned; the PDF.js patch marks it `latticeLayered` and the viewer CSS makes the rest static |
| PDF.js sized each page with `round(var(--total-scale-factor) * …px, var(--scale-round-x))` in its own style. A `var()` in an element's own style cannot use WebKit's matched-style cache, so each zoom restyled every page the slow way (2,000 such boxes: 21 ms in WebKit, 2.8 ms in Chromium; plain px: 6 ms) | The zoom's commit frame on the 1,930-page PDF: 43 → 35 ms | the PDF.js patch writes each page's size in px, once per scale change (`perf:bench`: 2 more style mutations per page per zoom or fit, so the `startup`, `pdf-open` and `pdf-zoom` mutation ceilings rose) |
| The zoom preview transformed the viewer in place, so WebKit repainted the scaled pages into the scroll area's tiles on every step | 74 → 91 fps on the 1,930-page PDF | the viewer is its own compositing layer (`will-change: transform`) for the gesture only (`pdf/use-pdf-zoom.ts`) |
| Opening a project waited for the whole bibliography index before the first document. Its label scan (`list_references`) takes about 10 s on a 3.2 MB `.tex`, in either engine | The root document of a project holding `long.tex` appeared after 11.2 s | only the paper list, which decides what the restore opens, is awaited; citations and labels arrive when ready (`app/use-project-lifecycle.ts`). Until they do, the outgoing project's keys and labels are cleared and the unknown-key and label diagnostics are held back (`indexPending` in `editor/latex/latex-diagnostics.ts`) |

Gate rows, as measured on main, then with these fixes (the bundled Chromium
in brackets, which gained from some of them too):

| Row | Before | After |
| --- | --- | --- |
| Drag a panel divider (fps) | 94 (119) | 121 (120) |
| …with the long Markdown document open (fps; longest frame ms) | 37; 797 (111; 34) | 98; 48 (113; 42) |
| 1,930-page PDF ctrl-wheel zoom (fps; longest frame ms) | 77; 47 (113; 25) | 95; 35 (109; 33) |
| 44 MB image PDF zoom (fps) | 100 (119) | 114 (120) |
| 1,930-page PDF jump to 70 % → painted (ms) | 82 (65) | 64 (58) |
| 1,930-page PDF fast scroll (fps) | 119 (106) | 120 (106) |
