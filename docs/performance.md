# Performance: how to measure, and what we found

The how-to comes first: the interaction benchmark CI gates on, the dev-app
probe, and the real-app lab ([`driving-the-app.md`](driving-the-app.md)). The
current status and open directions follow; every dated investigation is in
[`performance-history.md`](performance-history.md), oldest first.

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
| `tab-drag` | drag a document's tab past the PDF's split and tab targets and the terminal's edge, resting on each, drop it beside the PDF, then drag that panel back into the documents' tab strip, with the 400 KB Markdown document in the visual editor, the PDF and the terminal on screen |
| `compile` | build, then expand the diagnostics and show the 4,000-line log |

#### Running it

- `pnpm perf:bench` measures and prints a table. `--check` also exits 1 when a
  gated count exceeds its ceiling; that is what CI runs (the `perf-bench` job, and
  `mise run perf-bench` locally).
- `--only a,b` limits scenarios (with `--layout`, checks). `--shard K/N` deals
  the scenarios, then the layout checks, round-robin and runs the K-th share;
  CI splits each engine's run across runners with it. Neither writes ceilings.
- `--build-only DIR` builds the page into DIR, prints a hash of every file in
  it and exits; `--dist DIR` then measures (or serves) that build instead of
  building one. CI's `bench-page` job builds once on Linux and every shard of
  both engines measures that one build, whose hash each shard's log repeats.
- `--runs N` repeats each scenario and gates
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
- `--against REF` (for example `origin/main`) is the A/B for a local red. It
  builds REF from `git archive` beside this checkout, runs each scenario on both
  builds in one browser, alternating which goes first, and prints every count on
  both sides with the change. It holds no ceilings and exits 0. Pick the
  scenarios with `--only`.
- `--engine webkit` runs the scenarios in Playwright's WebKit (install it once
  with `pnpm exec playwright-core install webkit`) against
  `scripts/perf-bench/budgets-webkit.json`; CI runs it too (the
  `perf-bench-webkit` job, on macOS). Release builds render in WKWebView, and
  WebKit's cost per element styled or laid out is several times Chromium's, so
  a change that grows the DOM is caught in the engine users run. WebKit has no
  style or layout counters: its `recalcs` and `layouts` are blank and CPU
  profiles are Chromium-only.
- `--layout` checks geometry jsdom cannot lay out
  (`scripts/perf-bench/layout-checks.mjs`), each check on a fresh page at its
  own viewport and query, and exits 1 with a screenshot when one fails. Alone it
  runs no benchmark; with `--check` it runs after the benchmark on the same
  build, which is how CI runs it in both engines. A failing CI shard uploads
  its screenshots as the `perf-bench-<k>-screenshots` or
  `perf-bench-webkit-<k>-screenshots` artifact of the run. `paper-header-long-doi` opens a Paper
  with a very long DOI in a ~500px reader header and fails when the PDF action
  overlaps the source link or takes a click on its arrow.
  `reading-field-focus-after-shrink` shrinks the window under the Reading
  layout and fails when clicking and searching in the PDF beside the notes
  scrolls the workspace root. `writing-pdf-find-narrow` types a query into the
  PDF's Find under the Writing layout, shrinks the window to 640, 560 and
  480px, and fails when a toolbar control overlaps another or leaves the
  toolbar, or the query's box is narrower than a short query needs.
  `pdf-live-drag-copy` drags from page 1 to page 3 of a 400-page compiled PDF
  at 40% and, with the button still held, wheels far enough down that PDF.js
  evicts the selected pages from its render cache, then releases and wheels
  once more; it fails when the released drag or Cmd-C loses pages 1 and 2.

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
| `tab-drag` | `commits`, `renders`, `hooks` | `mutations` | Trellis moves the lifted panel and the panels making room for a drop on every frame, and how many frames a drag spans depends on the machine (10,909–11,356 across runs of one build). |
| `latex-typing`, `long-tex-typing` | `renders`, `hooks`, `mutations` | `commits` | A keystroke's updates commit together or apart depending on timing: 81–85 commits on one machine, 101 on the CI runner, with renders within 4%. |
| `markdown-visual-typing` | `commits`, `mutations` | `renders`, `hooks` | The 24 keystrokes publish in one or two batches depending on timing, and each batch re-renders the editor chrome (634–1,243 renders). |
| `code-highlight` | `commits`, `renders`, `hooks` | `mutations` | 2,510–2,957 across runs of one build. |
| `startup` | `commits`, `renders`, `hooks` | `mutations` | Trellis measures a panel's header by writing each state of its action row to the DOM, and again when the row changes size. On a busy machine the Project and Papers panels' actions arrive a frame after the first measurement, and the second adds about 95 attribute writes (WebKit: 721–738 at rest, 818–864 in about a run in four under load). |
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

A table of measurements added to this document lands with its evidence: the
raw runs under `docs/performance-data/` and a `measured` entry in
`docs/performance-data/manifest.json` naming both commits, the exact command,
fixture, engine and Node versions, viewport, run count and order, what each
figure means and how runs are aggregated. `pnpm perf:evidence` (part of `pnpm
check`'s lint stage and CI) recomputes every cell of such a table from those
runs and fails on an undeclared table; `scripts/check-perf-evidence.mjs`
describes the entry kinds. The page-window tables below are the worked
example.

## Status and directions

### React Compiler status

`scripts/react-compiler-report.mjs` prints every compiler bailout in the hot
files; `src/platform/react-compiler-guard.test.ts` pins per-file ceilings so new
bailouts fail CI. As of August 2026: the since-removed `editor-tabs.tsx` compiled fully, and
several syntax-level blockers (`??=`, inline `import()`, default-parameter `??`)
were cleared from `pdf-viewer.tsx`, the since-removed `visual-markdown-editor.tsx`,
and `document-canvas.tsx`'s hooks. Its replacement,
`editor/markdown/engine/lattice-visual-editor.tsx`, is pinned at 0 bailouts.
Since October 2026 `DocumentCanvas` compiles whole (item 3 below) and so does
`App.tsx`, whose last reports were
preserved-memo failures; the callbacks whose identity effects and children
depend on (the build-tracking reset whose cleanup cancels a queued build,
builds, Settings, the canvas's request settle) became one `useStableHandlers`
map, and the remaining `try/catch` bodies moved to `src/app/*-action.ts`.
Simply deleting those wrappers also reaches 0, but the compiler leaves such a
callback uncached, so an effect depending on it reruns its cleanup on every
keystroke; `app-builds.test.tsx` holds a queued build through typing to catch
that.

Run the report before planning any of this — a bailout's *cause* decides the
recipe, and guessing from the file name has been wrong before. Remaining,
in order of value:

1. Render-phase ref access, the *sole* bailout of its function:
   `telemetry/app-updater.tsx`. Where a ref is passed as an argument during
   render, the fix is to wrap it in a closure (`() => ref.current`) rather
   than to move a write. `project/project-find-dialog.tsx` had the same
   bailout and now compiles with 0.
   Working model in the repo: `CodeMirrorHost` (`editor/codemirror-host.tsx`)
   writes `propsRef` in an every-commit `useLayoutEffect` and compiles with 0 bailouts.
   Note a wrong fix cannot land silently: moving the write to an effect while
   leaving a `useMemo` that reads `.current` is still rejected, so the bailout
   guard catches it.
2. The PDF viewer — split into `pdf-viewer.tsx` and the `use-pdf-*` hooks, it
   is down from 5 bailouts to 1: `pdf-viewer.tsx` and `use-pdf-document.ts`
   compile with 0, and one preserved memo remains in `use-pdf-view.ts`. It is
   not a ref write.
3. `DocumentCanvas` was skipped wholesale for the `exhaustive-deps` disable
   on its source-editor extensions memo, which kept CodeMirror from
   reconfiguring on every keystroke. The extensions now come from the source
   session (`canvas/use-source-session.ts`, `canvas/source-session.ts`): one
   extension set per configuration (document, language, keymap,
   spellchecking), held in state and replaced only when that changes, with
   everything else read through committed getters. That identity is a
   contract rather than a cache, and `document-canvas.test.tsx` holds typing
   to zero reconfigures.

Note that these items do not gate each other, and none is load-bearing for
correctness: a render-phase ref access makes the compiler skip the *enclosing
function*, so these are lost optimisations, not latent bugs. The patterns that
do cause stale-render bugs are the ones the compiler cannot see — module-level
mutable state read during render, and objects mutated in place whose identity
never changes. A store read through a stable getter is the same pattern: the
canvas's per-file view states are read as each surface mounts
(`canvas/saved-view-state.tsx`), because a compiled parent can mount an
element it built earlier again. Two such bugs shipped and were fixed in August 2026; see the
comment in `vitest.config.ts` for how the test suite now catches them.

### Future directions (not yet scheduled)

- Opening a long Markdown document is now mostly reading it: the engine
  parses the whole file with micromark on the main thread on every open
  (about 370 ms in Chromium and 430 ms in WebKit for 2 MB). Caching the read
  by text, or reading in a worker, is what remains.
- `App.tsx` state extraction — in progress rather than unscheduled; its current
  size and extraction status live in `docs/codebase-map.md` §6. Still open: what `DocumentCanvas`
  re-renders on — App (`src/app/app-document-surfaces.tsx`) hands it ten domain models (`src/canvas/canvas-model.ts`) instead
  of a flat prop list, but the models still carry every field, so the call site
  and its inline lambdas are unchanged in substance.
- Split-mode publication: replace whole-document `setContent` with
  block-level splices; measure after the mdast-cache fix, which removed the
  worst multiplier.
- Long term: Obsidian-style single-editor live preview instead of two
  simultaneously mounted editors.
- CodeMirror remount-on-switch (`key={editorKey}`) if switching still
  feels slow after the IPC fixes.

Two items that used to sit in this list have **shipped** and are described under
"Library replacements" in [`performance-history.md`](performance-history.md#library-replacements-second-round-august-2026) — do not re-plan them:

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
  Harper (see [`performance-history.md`](performance-history.md#what-was-actually-slow-here-august-2026)).
- **Tauri IPC** — string serialization is the bottleneck; batch or
  parallelize round trips, never poll when a watcher will do, keep large
  payloads off the invoke path.

Sources: VS Code blog "Text Buffer Reimplementation" and "Optimizations in
Syntax Highlighting"; codemirror.net million-line example; Tauri discussions
#11915 / #7146 / #5690.

## History

The dated investigations, oldest first, are in
[`performance-history.md`](performance-history.md).
