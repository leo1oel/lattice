# Native structured Markdown CRDT Phase 9 evaluation

## Decision

The result is **NO-GO**.
Production remains on canonical `Y.Text("content")`, and the prototype is not imported by the production visual editor.
This decision follows correctness evidence rather than implementation complexity.

## Method

The isolated candidate uses the existing TipTap 3 ProseMirror schema and Markdown bridge.
It projects the ProseMirror document into a sole authoritative `Y.XmlFragment` tree and does not create a canonical or mirrored `Y.Text`.
Source-mode changes run as explicit guarded conversions, while visual changes target the same fragment.
A conversion is rejected before writing when parse and serialization are not byte-identical.
Rejected, failed, timed-out, and stale conversions return the complete source draft for export and recovery.

The syntax fixture matrix covers ATX and setext headings, emphasis, strong, strike, nested and task lists, aligned tables, fenced and indented code, inline and display math, frontmatter, HTML, comments, inline and reference links, autolinks, images, footnotes, blockquotes, callouts, current `rw-component` fences, LaTeX commands and environments, Unicode, emoji, BOM, CRLF, trailing whitespace, and final-newline variants.
Opening and no-op round trips are compared as bytes, with no semantic-equivalence allowance.

Concurrency evaluation uses two independently edited `Y.Doc` peers and exchanges updates in both directions.
Fault evaluation injects parse exceptions, a post-parse exception, serialization exceptions, timeouts, and a remote update between parse and commit.
Cursor evaluation samples 23 boundaries spanning surrogate pairs, marks, lists, tables, and code.

Benchmarks use fixed small, medium, and large fixtures.
The test computes current `Y.Text` and structured parse, serialization, mode-switch, update, and snapshot costs in the same process, and emits relative time and byte ratios rather than checking in machine-specific output.

## Results and failed gates

The byte-lossless syntax gate fails because TipTap's Markdown bridge canonicalizes source forms and does not represent every required construct.
BOM, CRLF, source delimiters, whitespace details, and unsupported extension syntax cannot all survive an opening or no-op round trip byte-for-byte.

The concurrency gate fails because whole-tree source conversions are concurrent structural replacements.
Yjs converges at the data level and both peers serialize identically, but the result is not the intended merge of non-overlapping source changes and may retain competing document roots.
This also fails the no-duplicate-content and repeated mode/offline gate.

The cursor gate fails because exact source offsets cannot be mapped through a canonicalizing conversion.
The bridge therefore returns no mapping instead of fabricating an inaccurate cursor.

Unsupported-input and stale-conversion safety gates pass in the isolated harness.
The fragment remains unchanged, the full local draft remains recoverable, and a remote state arriving during conversion is not overwritten by an older result.

Performance ratios are printed by the prototype benchmark test for the current machine.
They are supporting evidence only, because the mandatory correctness failures already force a NO-GO regardless of speed.

## Capabilities required for a future GO

- The upstream bridge must expose a lossless concrete-syntax representation for every required Markdown construct, including delimiters, line endings, BOM, trailing whitespace, and final-newline state.
- The ProseMirror schema and Markdown bridge must natively preserve frontmatter, HTML and comments, references, footnotes, math, callouts, `rw-component` fences, and LaTeX without opaque fallback loss.
- Source conversion must produce stable fine-grained fragment operations that merge non-overlapping edits and reject or explicitly resolve overlaps without duplicate roots.
- The bridge must provide bidirectional UTF-16 source-to-document position maps that remain accurate across marks, surrogate pairs, lists, tables, and code.
- Conversion commits must retain the tested state-vector or equivalent generation guard so remote updates cannot be overwritten by stale work.
- Fixed-fixture relative performance must remain within the gate once correctness is achieved, with a failure when a greater-than-two-times regression is user-perceptible.

Only after all gates pass should this candidate be exposed behind an opt-in feature flag that defaults off and retains source export, draft recovery, and a `Y.Text` fallback path.
