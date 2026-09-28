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
| Frozen table-header scroll animations outlived their cells | Scroll-driven `Animation`s stay in effect while the scroller is connected. Each file switch kept the replaced document alive through its header cells: +6.6k DOM nodes and +3.2 MB heap per `large.md` ⇄ note switch, with split-preview fps falling as stale animations piled up | the plugin view tracks animated cells and releases dropped ones (`open-knowledge-app/editor/extensions/frozen-table-headers.ts`) |
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
fails a pull request that makes one of them do more work. It builds
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
  count exceeds its ceiling; that is what CI runs (the `perf-bench` job, and
  `mise run perf-bench` locally).
- `--only a,b` limits scenarios. `--runs N` repeats each scenario and keeps the
  run with the fewest counts, because noise only ever adds work. The default is
  2.
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

`scripts/perf-bench/budgets.json` holds a ceiling per scenario and count. A
ceiling sits 20% (at least 5) above the measurement that set it. Commits,
renders and hooks repeat exactly from run to run. Recalculations and layouts
move a few percent with frame alignment and differ between the laptop that set
a ceiling and the CI runner, and so do mutations in the scroll scenarios: a
Lattice scrollbar fades out 180 ms after the last scroll event, and how many of
40 notches that falls between depends on the machine (each fade is about six
recalculations, which is why `pdf-scroll`'s recalculation ceiling was set from
a slower machine's 131). The reveal is written to the DOM, not React state, so
it adds no commits. A regression worth catching multiplies a count.

- `pnpm perf:bench --ratchet` lowers every ceiling the counts now beat, and
  never raises one. Run it after a speedup lands and commit the new
  `budgets.json`. `--check` lists the ceilings that have room to ratchet.
- Raising a ceiling is a hand edit with a reason in the pull request.
  `--update` rewrites every ceiling from one run; review that diff like code.
- A new scenario gets its ceilings on its first full run.

### This round's findings (September 2026)

The techniques came from Anthropic's write-up on making claude.ai faster. Each
fix below was found by the benchmark or a trace and checked by it afterwards.
Counts are per interaction on the production build, best of two runs. The
code-block row predates pacing `code-highlight`'s keystrokes past the
publication idle, so that scenario now publishes on every key and counts more
than the row shows.

| Interaction | commits | renders | hooks | recalcs | layouts | mutations |
| --- | --- | --- | --- | --- | --- | --- |
| startup (per load) | 25 → 22 | 3,395 → 1,740 | 16,993 → 11,654 | 83 → 83 | 59 → 58 | 1,512 → 1,453 |
| LaTeX typing (per key) | 3.1 → 2.0 | 1,143 → 205 | 6,674 → 1,746 | 13.0 → 9.9 | 5.1 → 5.1 | 40.5 → 19.3 |
| Markdown source typing | 2.1 → 1.1 | 323 → 150 | 3,096 → 1,537 | 6.7 → 6.7 | 3.1 → 3.1 | 7.4 → 7.4 |
| Markdown visual typing | 1.4 → 1.2 | 77 → 28 | 649 → 228 | 1.8 → 1.5 | 1.2 → 1.1 | 4.7 → 4.3 |
| file switch (per switch) | 15.3 → 13.5 | 3,512 → 2,517 | 17,413 → 13,358 | 100 → 73 | 50.8 → 24.3 | 2,954 → 2,930 |
| code blocks (per action) | 2.1 → 2.0 | 707 → 643 | 3,563 → 2,951 | 13.0 → 5.5 | 10.1 → 3.1 | 234 → 240 |
| open a 200-page PDF | 18 → 14 | 2,278 → 731 | 8,774 → 4,427 | 68 → 64 | 34 → 34 | 1,197 → 1,131 |
| PDF scroll (per notch) | 1.0 → 0.8 | 149 → 35 | 630 → 306 | 2.9 → 2.4 | 1.0 → 1.1 | 26.6 → 22.4 |
| source scroll (per notch) | 0.1 → 0.1 | 0.1 → 0.1 | 0.5 → 0.5 | 1.7 → 1.7 | 0.3 → 0.3 | 17.7 → 17.7 |
| Markdown preview scroll | 0.3 → 0.3 | 3.5 → 3.5 | 25 → 25 | 3.5 → 3.6 | 0 → 0 | 4.8 → 4.8 |
| compile and show the log | 8 → 8 | 1,946 → 1,084 | 11,133 → 8,699 | 83 → 80 | 9 → 9 | 159 → 123 |

Wall-clock, same runs, on one Apple-silicon laptop, so only the large changes
carry meaning. Main-thread work for 24 visual-editor keystrokes fell from 4.8 s
to 0.5 s, and long tasks from 27 to 2. Switching to the code-block document fell
from 2.5 s of task time to 1.0 s, with style recalculation going from 1,060 ms to
298 ms and long tasks from 5 to 1.

| Cause | Evidence | Fix |
| --- | --- | --- |
| The visual editor parsed every block of the document after each pause in typing. The caret report mapped the caret through `exactVisualSourceRanges`, which parsed each top-level block on its own (about 1,000 parses at 400 KB). When that failed on the edited block, it serialized the whole document only for `reportVisualCaret` to discard the result. | CPU profile over 40 keystrokes: 10.1 s of main-thread tasks, 42 long tasks. `parseVisualMarkdown` took 8.2 s of that, inside `sourceOffsetForProseMirrorPosition` (7.5 s), and `renderedRootCount` took 5.6 s. | Memoize root counts per block source and ranges per text; skip the whole-document fallback while edits wait for publication; reuse the cached parse in `restoreUnchangedBlocks` (`editor/markdown/visual-source-map.ts`, `visual-markdown-serialization.ts`, `visual-markdown-editor.tsx`) |
| Each LaTeX keystroke rendered all of App three times. CodeMirror reports a `pending` completion query for every typed letter and then `null`, and each edge flipped `editorCompletionActive` in App. `useDeferredValue(source)` for the TODO badge re-rendered App a third time. | Update origins: `App#84` (completion state) changed 80 times in 40 keystrokes. About 380 components rendered per App commit. | `pending` keeps the last answer (`canvas/document-canvas.tsx`). The TODO rescan runs in the keystroke's own render. |
| The TODO rescan split the document into lines and lowercased every line on each keystroke. | Visible in the deferred render above | One case-insensitive search finds the candidate lines first (`project/todo-scavenger.ts`) |
| The React Compiler skipped `PdfPreview`, because PDFSlick's property setters in its callbacks and two Lingui tagged templates blocked it. Uncompiled, `PdfPreview` re-rendered its toolbar and about 11 tooltips whenever the canvas did, including on every editor keystroke. | 231 of the 1,143 renders per LaTeX keystroke. 149 renders per PDF scroll notch. | Setters moved to module helpers, descriptor-form messages (`pdf/pdf-viewer.tsx`). The compiler guard pins the file at 0 bailouts. |
| Every TipTap React node view forced a synchronous style and layout pass as its content attached: `captureDOMSelection` reads `selection.rangeCount`. | Trace of opening a document with 150 code blocks: 150 forced style recalculations and 150 forced layouts, all with the stack `captureDOMSelection < nodeViewContentRef`. 238 recalculations in total. | The `@tiptap/react` patch reads the selection only when the content sits in the focused element, where a caret can be. The same open then took 91 recalculations. |
| Frozen table headers and table insert controls measured each table right after writing to the previous one. | Trace of switching to `large.md` (40 tables): 35 forced passes from `computeAndApplyFrozenHeaders` and 36 from floating-ui `autoUpdate` in `addOverlay` | Measure every table, then write (`frozen-table-headers.ts`). Mount every overlay, then start positioning (`table-insert-controls.ts`). |
| The heading rail queried every heading once per rail item, which is quadratic, and it re-measures after every edit. | 1,455 ms of `querySelectorAll` self time opening the 150-section code document | One query per measure (`editor/markdown/document-heading-rail.tsx`) |
| The titlebar's tab strip, the navigator's protected paths and the build pipeline object were fresh on every App render. | Titlebar subtree re-rendered about 80 components per keystroke | Memoized in `App.tsx` and `app/use-build-pipeline.ts` |

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

Still open: App itself is not compiled (22 bailouts, see below) and renders
about 200 components per keystroke. A PDF page change re-renders App because
the agent context reads the page number. Radix tooltips and popovers render
twice as they mount, which a document full of node views multiplies.

## Results log

The long-session measurements above are recorded in their own section. For
the keystroke and switch playbook, **nothing has been recorded yet.** The table below is an empty template,
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
2. Render-phase ref access in `visual-markdown-editor.tsx` — its one
   remaining bailout, in `CompleteVisualMarkdownEditor`, on the typing hot
   path: the refs handed to `hostExtensions` during render. It is the
   ref-passed-as-argument shape, so the fix is to wrap in a closure
   (`() => ref.current`) rather than to move a write. Cheaper wins of the same
   kind, each the *sole* bailout of its function: `app/use-panel-layout.ts`,
   `project/project-find-dialog.tsx`, `telemetry/app-updater.tsx`.
   Working model in the repo: `editor/codemirror-host.tsx:116-124` writes its
   refs in an every-commit `useLayoutEffect` and compiles with 0 bailouts.
   Note a wrong fix cannot land silently: moving the write to an effect while
   leaving a `useMemo` that reads `.current` is still rejected, so the bailout
   guard catches it.
3. The PDF viewer — split into `pdf-viewer.tsx` and the `use-pdf-*` hooks, it
   is down from 5 bailouts to 3: a `tagged template with interpolations` in
   `pdf-viewer.tsx` and in `use-pdf-document.ts`, and one preserved memo in
   `use-pdf-view.ts`. None is a ref write.
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
  longer unused: `src/editor/markdown/markdown-workspace-index.ts:143` calls it on every
  corpus update.
