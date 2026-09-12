# Open Knowledge selective updates

## 2026-09-12

Selectively adopted the animation-start technique from [PR #4251](https://github.com/inkeep/open-knowledge/pull/4251).
Replacement frozen-header animations start at scroll-timeline zero; engines without percentage start-time support retain the existing fallback.
The local geometry tolerance and optional occluder remain intact.

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
