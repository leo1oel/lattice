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
| Visual editor renders the whole document into the DOM; the upstream `content-visibility` chunking plugin was never vendored (CSS was) | `editor-globals.css` `.ok-chunk-wrapper`, upstream `chunk-wrapper-decoration.ts` (the vendored editor, removed in phase 3 of the visual editor rebuild) |
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
| Cursor/scroll restore was gated behind an unrelated `stat` round trip; save and read ran serially | `App.tsx` `loadFile` |
| `read_file` read every file twice (classification pass + content pass) | `project.rs` |

Ruled out: agent streaming (cross-origin iframe + postMessage, zero React
cost), Tauri `listen()` handlers (9 non-test call sites today, all cleaned
up), file tree (already virtualized).

A constraint to respect: **editable surfaces deliberately do not use
`content-visibility: auto`** — deferred materialization destabilizes WebKit
selection anchoring. Large read-only documents render through the engine's
passive view (`editor/markdown/engine/passive-view.tsx`) instead; deferring
rendering in editable docs is a separate experiment behind a flag, measured
before adoption.

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
4. `__latticePerf.report()` dumps everything. Record numbers in the table
   below per stage.

## Long-session degradation (September 2026)

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

## Interaction benchmark and CI gate (September 2026)

`pnpm perf:bench` measures Lattice's hot interactions deterministically, and CI
fails a pull request that makes one of them do more React or DOM work. It builds
`tools/perf-bench/` with the production config. That page is the real app, with
an in-memory backend holding the fixture project from `scripts/perf-fixture.mjs`
(the same content `gen-perf-fixture.mjs` writes to disk, at smaller sizes). The
benchmark drives it in headless Chrome over the DevTools protocol with real
mouse, wheel and key events at a fixed cadence. Every step waits for the next
frame and a fixed pause, as a person would, so debounced work fires the same
number of times on a fast laptop and a slow runner. Each run ends when nothing
has committed or mutated for 1.5 s, longer than the app's slowest idle debounce.

What it counts, per interaction (`scripts/perf-bench/probe.js`, injected before
any page script):

| Count | Source |
| --- | --- |
| `commits` | React commits, through a minimal React DevTools global hook |
| `renders` | components that rendered in those commits (the `PerformedWork` walk React DevTools uses) |
| `hooks` | hooks those renders ran |
| `recalcs`, `layouts` | Chromium's own `RecalcStyleCount` / `LayoutCount` (`Performance.getMetrics`) |
| `mutations` | `MutationObserver` records over the whole document |

It also reports long tasks, layout shift by app region (titlebar, sidebar,
source editor, visual editor, PDF, diagnostics), and script, style, layout and
task durations. Those are wall-clock facts: reported, never gated.

Scenarios (`scripts/perf-bench/scenarios.mjs`):

| Scenario | Interaction |
| --- | --- |
| `startup` | load the app and open the fixture project with its PDF preview |
| `latex-typing` | 40 characters into a 60 KB chapter, PDF preview beside it |
| `markdown-source-typing` | 40 characters into the 400 KB Markdown document's source |
| `markdown-visual-typing` | 24 characters into it in the visual editor (one publication) |
| `file-switch` | tab switches between `main.tex`, `large.md`, a note and a chapter |
| `code-highlight` | switch to a document of 150 highlighted code blocks, type 20 characters in one (each after the 200 ms publication idle, so each publishes) |
| `pdf-open` | open a 200-page PDF from the navigator |
| `pdf-scroll`, `source-scroll`, `markdown-preview-scroll` | 40 wheel notches each |
| `compile` | build, then expand the diagnostics and show the 4,000-line log |

### Running it

- `pnpm perf:bench` measures and prints a table. `--check` also exits 1 when a
  gated count exceeds its ceiling; that is what CI runs (the `perf-bench` job, and
  `mise run perf-bench` locally).
- `--only a,b` limits scenarios. `--runs N` repeats each scenario and keeps the
  run with the fewest gated counts, because noise only ever adds work; the
  report-only counts shown are that same run's and do not affect the choice.
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

### Ceilings and the ratchet

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
| `latex-typing` | `renders`, `hooks`, `mutations` | `commits` | A keystroke's updates commit together or apart depending on timing: 81–85 commits on one machine, 101 on the CI runner, with renders within 4%. |
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

### This round's findings (September 2026)

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

Still open: App itself is not compiled (17 bailouts, see below) and renders
about 200 components per keystroke. A PDF page change re-renders App because
the agent context reads the page number. Radix tooltips and popovers render
twice as they mount, which a document full of node views multiplies.

## React Compiler status

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

1. `App.tsx` — ~32 `try/finally` callback bodies plus a handful of throws
   inside try. Recipe: hoist each body to a module-level function taking a
   deps object, leave the `useCallback` as a thin arrow; per-file commits so
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
- **Full BM25 rebuild → incremental page index**
  (`markdown-workspace-index.ts` feeds `PageSearchIndex.update` in
  `src/project/workspace-search.ts`, which indexes page names only and reuses
  the analysis of every page whose name is unchanged).

Considered and deliberately kept: CodeMirror 6, Yjs, pdf.js, KaTeX,
lowlight, TipTap/ProseMirror (the split-mode cost is architectural, not the
library — see Future directions).

## Future directions (not yet scheduled)

- Editable-doc `content-visibility` experiment behind a dev flag, with
  selection/scroll behavior measured on WKWebView before any default flip.
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
"Library replacements" above — do not re-plan them:

- The `notify` filesystem watcher replacing the 2-second poll
  (`src-tauri/src/fs_watch.rs`, the `watch_project` command, the
  `project-fs-changed` event).
- The incremental BM25 workspace index (`PageSearchIndex` in
  `src/project/workspace-search.ts`, updated on every corpus publication by
  `src/editor/markdown/markdown-workspace-index.ts`).
