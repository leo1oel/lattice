# Open Knowledge selective updates

## 2026-09-28

Reviewed [v0.78.0..v0.79.0](https://github.com/inkeep/open-knowledge/compare/v0.78.0...v0.79.0), from [90ef743c](https://github.com/inkeep/open-knowledge/commit/90ef743c07f438b1440f9fcbe4a8878a1d055682) through [1f7787f9](https://github.com/inkeep/open-knowledge/commit/1f7787f99374d516961cf5b377ce7b5612361b60).
Checked all 29 commits against the app vendor manifest and both lockfiles; five touch files Lattice vendors, all in core.
Per the September 28 decision to rebuild the visual Markdown editor as Lattice-owned code and relicense Lattice to Apache-2.0, this review permits only bug or security fixes affecting current Lattice users, with no new upstream features.

### Adopted

None: no qualifying bug or security fix reaches Lattice's current vendored code.
The vendored files, local overrides, and c234a9c6 app/core pins remain unchanged; this review changes only this log and does not implement the rebuild or relicensing.

### Reviewed and declined

- [PR #4938](https://github.com/inkeep/open-knowledge/pull/4938): the process-cleanup fix is in upstream test infrastructure Lattice does not ship; its only changes to vendored files add leading blank lines to `doc-boundary-space.ts`, `comment-promoter.ts`, `merged-walker.ts`, and `safe-url.ts`.
- [PR #4995](https://github.com/inkeep/open-knowledge/pull/4995): upstream consumer-tier test selection is outside Lattice's vendored code, and the four vendored-file edits only remove those leading blank lines.
- [PR #5004](https://github.com/inkeep/open-knowledge/pull/5004): GitHub and ticket reference previews are a new upstream agent-chat feature; the core barrel exports are replaced by Lattice's local seam, and the other four vendored-file edits only restore the blank lines.
- [PR #5005](https://github.com/inkeep/open-knowledge/pull/5005): the remembered `xhigh` effort fix belongs to upstream agent-chat persistence that Lattice does not ship; its four vendored-file edits only remove the blank lines again.
- [PR #5007](https://github.com/inkeep/open-knowledge/pull/5007): agent-chat bug reporting adds exports to the upstream core barrel that Lattice replaces, with no change to Lattice's editor behavior.

## 2026-09-27

Reviewed upstream from [83e6aa94](https://github.com/inkeep/open-knowledge/commit/83e6aa94455d47f8d68baf380cb1dcbd8e4c439f) through [v0.78.0](https://github.com/inkeep/open-knowledge/releases/tag/v0.78.0) ([90ef743c](https://github.com/inkeep/open-knowledge/commit/90ef743c)), limited to the commits that touch vendored app/core files.
The app/core lockfiles keep the c234a9c6 pin: the vendored tree is not v0.78.0, so the local-override hashes record these semantic ports, as on 2026-09-07.
Ported files that do not exist at the pin (`jsx-node-target.ts`, `escape-provenance.ts`, `parser-reservations.ts`, `wiki-escape.ts`) are recorded as Lattice-only.

### Adopted

- [PR #4722](https://github.com/inkeep/open-knowledge/pull/4722): closing a hover-opened link or component panel no longer refocuses the editor, so it no longer scrolls back to the caret.
  Focus returns to the editor only when it was inside a closing layer surface; upstream's DOM test is included.
- [PR #4638](https://github.com/inkeep/open-knowledge/pull/4638): every JSX component action re-resolves its live target before dispatching, not only the auto-conversion ported on 2026-09-19.
  Move, delete, properties, source edit, child insertion, and host writes no longer act on a stale position, which could delete or overwrite a neighboring block.
  A changed or removed target is refused with a notice and counted in the new `jsxActionAborted` parse-health counter; chrome deletes have their own `jsxChromeDeleteFailed` counter.
- [PR #4535](https://github.com/inkeep/open-knowledge/pull/4535): `[[Page\|Alias]]`, the form a table cell requires, now resolves to `Page` instead of `Page\`, and anchors and embeds get the same fix.
  The authored escape is still written back byte-for-byte, and escape-only targets are no longer links; upstream's parser tests are included.
- [PR #4510](https://github.com/inkeep/open-knowledge/pull/4510) (parser half only): the parser records which characters were escaped, instead of recovering them from source offsets afterwards.
  Escapes on continuation lines of block quotes and list items now survive editing, so `\[foo\]` no longer becomes a live reference link when `[foo]:` is defined.
  Across the CommonMark spec examples, the GFM fixtures, and this repository's Markdown, 46 inputs now round-trip exactly and none regressed.
- [PR #4889](https://github.com/inkeep/open-knowledge/pull/4889): vendored dropdowns, submenus, and popovers keep an 8px margin from the viewport edge.
- [PR #4350](https://github.com/inkeep/open-knowledge/pull/4350), remaining vendored part: the selection bubble menu hides while its text is being dragged.

### Adapted

- #4510: upstream records an empty escape when an escaped `<` opens HTML or JSX, such as `a \<u>x\</u> b`, and the editor then duplicates the surrounding text.
  Lattice records the escape only when the `<` is still in the same text, which keeps the previous result.
  The Lattice-only `\(…\)` math promoter now keeps escape provenance on the text it splits.
- #4638: the target helpers are a local seam beside `JsxComponentView`, notices go through the app-log toast shim, and the strings stay English like the rest of the vendored UI.
  Lattice's own image-alignment control goes through the same property-edit guard.
- #4350: Lattice's block controls do not use upstream's bubble-menu plugin key, so only the drag check was taken.

### Reviewed and declined

- [PR #4262](https://github.com/inkeep/open-knowledge/pull/4262) and [PR #4222](https://github.com/inkeep/open-knowledge/pull/4222): comment stripping and lint-directive renames with no behavior change; Lattice keeps the explanatory comments.
- [PR #4146](https://github.com/inkeep/open-knowledge/pull/4146): mechanical TypeScript 7 rewrites.
  Its `LinkFidelity` change is already covered, because Lattice spreads the stock Link defaults and its `validate` uses the same allowlist.
- The generated-index half of [PR #4510](https://github.com/inkeep/open-knowledge/pull/4510): it serves upstream's server-written index files, and Lattice has none.
- [PR #4374](https://github.com/inkeep/open-knowledge/pull/4374): palette cross-fades rely on upstream's color-theme transition infrastructure, which Lattice's theme seam does not have.
- [PR #4272](https://github.com/inkeep/open-knowledge/pull/4272): the popup-label type and scroll-host selector apply to upstream's Ask AI composer and document scroller.
- [PR #4819](https://github.com/inkeep/open-knowledge/pull/4819) (right-to-left logical spacing), [PR #4913](https://github.com/inkeep/open-knowledge/pull/4913) (optional tooltip arrow), [PR #4657](https://github.com/inkeep/open-knowledge/pull/4657) (destructive-button dark text), [PR #4785](https://github.com/inkeep/open-knowledge/pull/4785) (skill blurbs in the slash menu), and [PR #4460](https://github.com/inkeep/open-knowledge/pull/4460) (case-insensitive doc names): Lattice has no right-to-left locale, no caller, or no skills category for them.
- Core barrel, handoff, MCP-constant, and API-schema additions (for example [PR #4931](https://github.com/inkeep/open-knowledge/pull/4931), [PR #4853](https://github.com/inkeep/open-knowledge/pull/4853), and [PR #4102](https://github.com/inkeep/open-knowledge/pull/4102)) support upstream's desktop agents, sync, and server, which Lattice does not embed.
- [PR #4251](https://github.com/inkeep/open-knowledge/pull/4251) and the list-dragging part of [PR #4350](https://github.com/inkeep/open-knowledge/pull/4350) were already handled on 2026-09-12.

Still open upstream and here: an escaped `\<https://…\>` is read as an autolink ending in a backslash, and `\<u>…\</u>` becomes underline.

### Local fixes

Local fix to the frozen table-header override, not taken from upstream.
The plugin view now tracks every header cell it animates; each full pass and `destroy()` cancel the scroll-driven animations of cells ProseMirror has dropped and unhook replaced table wrappers.
A scroll-driven animation stays in effect after its cell leaves the document because its timeline source, the scroller, is still connected, so each file switch in the visual editor kept the replaced document's DOM alive and left more stale animations for every scroll frame to sample.
Worth offering upstream, where the same WeakMap-only bookkeeping exists.

## 2026-09-12

Selectively adopted the animation-start technique from [PR #4251](https://github.com/inkeep/open-knowledge/pull/4251).
Replacement frozen-header animations start at scroll-timeline zero; engines without percentage start-time support retain the existing fallback.
The local geometry tolerance and optional occluder remain intact.

Adapted the sibling-reordering behavior of [PR #4350](https://github.com/inkeep/open-knowledge/pull/4350) to Lattice's own block controls.
Dragging and the existing move-up/down shortcuts can reorder individual or selected sibling list items, including inside nested lists.
Moves preserve task state and selection direction, and ordered lists renumber from their existing start.
Cross-list movement and list-type conversion are deliberately excluded.
A document update during a pointer gesture cancels that gesture rather than applying stale positions.

Did not import upstream's Hocuspocus stale-write ledger or snapshot-based convergence wait.
Lattice already merges editor saves against their loaded disk baseline, and its collaboration tests do not use state-vector equality as a convergence check.
This does not add protection against arbitrary external programs restoring old files, nor a new restart-recovery guarantee.

## 2026-09-07

Reviewed upstream through [83e6aa94](https://github.com/inkeep/open-knowledge/commit/83e6aa94455d47f8d68baf380cb1dcbd8e4c439f) against our August 30 baseline.
The app/core lockfiles deliberately retain that baseline; their local-override hashes record these semantic ports, not a wholesale upstream upgrade.

### Adopted

[PR #3994](https://github.com/inkeep/open-knowledge/pull/3994) removes the automatic trailing paragraph and preserves an explicitly authored single trailing blank line.
Lattice keeps its existing **Add block below** control instead of importing upstream's separate trailing-zone widget.
Closing a final image's properties now leaves a gap cursor rather than searching backwards into the image, and that cursor uses the theme's text color.
The local frontmatter-envelope guard remains intact.

### Reviewed without importing upstream infrastructure

- [PR #4071](https://github.com/inkeep/open-knowledge/pull/4071): Lattice owns undo in `document-canvas.tsx`, delegates collaboration undo to the active session, clears detached visual snapshot history on external source changes, and reconciles visual content without retaining stale ProseMirror history.
  Upstream's parked CodeMirror/Hocuspocus lifecycle fix is not a drop-in change for this model.
- [PR #4139](https://github.com/inkeep/open-knowledge/pull/4139): Lattice reads external changes from disk rather than routing Synara writes through upstream's normalization-based persistence store.
  An App regression checks that a blank-line-only external edit survives polling and a subsequent local save.
- [PR #4162](https://github.com/inkeep/open-knowledge/pull/4162): the visual editor already coalesces updates into one publication drain and marks its emitted source as representable to skip a second eligibility serialization.
  Upstream's canonical block-map memoization depends on its separate server observer architecture; no unmeasured performance claim or server code was imported.
- [PR #4108](https://github.com/inkeep/open-knowledge/pull/4108): there is no equivalent Synara whole-file follow-scroll path to patch.
- [PR #4007](https://github.com/inkeep/open-knowledge/pull/4007): our CodeMirror state/view dependency declarations already exceed the corrected minimums.

Pierre diff rendering, Excalidraw updates, and Hocuspocus transport/persistence changes were not imported: Lattice has different UI, board, and collaboration ownership.

### Unused-code cleanup

Removed the unreferenced upstream drag handle, block mover, heading anchors, image-alignment bubble buttons, workspace-path helpers, and obsolete Ask-AI/terminal event shims.
The Lattice block controls, stateful heading anchors, and image chrome remain the active implementations.
Removed the CSS-hidden code-block Ask-AI button and its no-listener comment event and embedded-host hook, rather than keeping a nonfunctional control mounted.
Removed the unused Mermaid promoter; Mermaid fences remain ordinary code blocks rendered through `CodeBlockView` and `MermaidView`.
The vendor manifest and lockfiles omit the removed files so re-vendoring cannot restore them.
