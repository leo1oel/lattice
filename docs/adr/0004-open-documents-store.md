# 0004. The open documents are one hook-owned store

- **Status:** Accepted
- **Date:** 2026-10-02
- **Deciders:** repository maintainer, on the tech-debt design pass (`fm/tech-debt-design-pass`)

## Context

At `ac33c5eb` (2026-10-02) `src/App.tsx` was 4,251 lines. It owned the open
documents, the tab strip and the project lifecycle through dozens of loose
values: the active file and its buffer, the saved text and their ref twins,
the Paper and asset in front, `openTabs`, `tabRecency`, `closedTabsRef`,
`fileLoadGenerationRef`, `documentModeRef`, `htmlViewModesRef`,
`pendingWorkspaceSurfaceRef`, the navigation stack and more. Five openers and
three closers each repeated the same ceremony: reserve a generation, publish
deferred visual edits, save what is about to be covered, read, re-check, commit.
`use-document-buffers.ts` exposed 40 raw setters and refs, so its rules lived in
App. The React Compiler skipped App (17 bailouts), and App carried 9 lint
warnings.

The constraints any replacement had to keep:

- one text buffer is always loaded, with an optional Paper or asset in front of it;
- a read that lands after a newer intent is dropped;
- a failed save keeps the old document;
- the save of the outgoing file overlaps the read of the incoming one, unless the target aliases the dirty buffer;
- the two-phase project restore (`initialProjectProbe` must still beat the recent-project reopen);
- autosave timing;
- closed-tab reopen;
- Trellis's `tabsReady` gate;
- no extra work per keystroke.

## Options compared

Three interface shapes were designed independently:

- **A. Minimal.** `view`, `open(intent)` and `apply(change)`, with discriminated unions for every intent and change. It has the fewest entry points, but the number of concepts does not shrink, and `ResultOf<C>` typing hides what a call returns.
- **B. Pure core with ports.** A reducer and controller with no React or I/O, a `DocumentIO` port (with an in-memory adapter for tests), and an external store that components subscribe to by slice. It is the most testable shape and would let children skip renders while typing. It replaces React state with `useSyncExternalStore`, which changes the commit timing the code relies on (refs written ahead of state, layout effects). That made it too risky for a behaviour-preserving refactor.
- **C. Common caller.** A React-state hook with named commands: `open(key)`, `accept` for "durable text reached disk", `load`, `save`, plus `enter`, `remove` and `move` for the rare cases. It churns consumers moderately, and every call site reads plainly.

## Decision

Take C's shape with two ideas from A, in `src/app/use-open-documents.ts`.

- **From A, stable commands:** every command reads the latest state through refs, so its identity never changes on a keystroke.
- **From A, a two-phase entry:** project entry returns a handle, `enter(snapshot)` → `{ restore(papers), finish() }`, which keeps the restore ordered around App's slow scans.
- **The readers:**
  - `openFile`, `openPaper` and `openAsset` take a path or a Paper;
  - `open(key)` dispatches a tab key the way Trellis names it;
  - `close`, `reopenClosed` and `go` cover the tab strip and history;
  - `chooseMode`, `choosePaperView` and `reveal` change the view.
- **The buffer:**
  - `save` and `flush`;
  - `accept`, with an optional compare-and-swap, replaces five "commit text" variants;
  - `load`, `edit` and `clear`.
- **Tree changes:** `remove` and `move`.
- **Absorbed into the store:** the view states, autosave, the external-edit poll and the PDF version recheck.

App was then split along the seams this exposed:

- `use-project-lifecycle.ts`
- `use-project-tree.ts`
- `use-synctex-navigation.ts`
- `use-latex-structure.ts`

## Consequences

- Every way of changing what is on screen goes through the store's commands, and `use-open-documents.test.ts` states what they guarantee. New openers must not reach for raw buffer setters; there are none to reach for.
- Measured against `ac33c5eb` on 2026-10-02 with `pnpm perf:bench`:
  - commits and renders are unchanged in every scenario;
  - hooks run per scenario fell 5–7% (for example, `latex-typing` went from 50,431 to 47,356), because the store and the four hooks compile under the React Compiler.
- App is 1,921 lines with no lint warnings. It still bails out of the compiler on its own manual memoization (16 reports). Compiling App is the next step for typing cost, and it needs App's remaining callbacks to stop passing whole hook results around.
- The layout's `tabRecency` and `pinnedTabs` were dropped: nothing had read them since the dual-pane editor went (#70). Older saved layouts still load.

## Status changes
