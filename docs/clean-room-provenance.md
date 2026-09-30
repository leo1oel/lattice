# Clean-room provenance of the visual Markdown editor

Lattice's visual Markdown editor was once built on vendored code from
[Open Knowledge](https://github.com/inkeep/open-knowledge) (inkeep/open-knowledge,
GPL-3.0-or-later). This record shows how that code was replaced by Lattice's own
engine (`src/editor/markdown/engine/`), and what the scans run before the
Apache-2.0 relicense found. It lists tools, settings, scores and file paths only.
No Open Knowledge text is reproduced here, and none was read to produce it.

## The rebuild

| Step | Pull request |
| --- | --- |
| Phase 1: the engine's round-trip core and basic nodes, behind a switch | [#53](https://github.com/leo1oel/lattice/pull/53) |
| Phase 2, part 1: rich blocks, node views and the quarantined differential harness | [#55](https://github.com/leo1oel/lattice/pull/55) |
| Phase 2, part 2: editor chrome | [#56](https://github.com/leo1oel/lattice/pull/56) |
| Phase 2, part 3: integration behind engine-agnostic interfaces | [#57](https://github.com/leo1oel/lattice/pull/57) |
| Phase 3: the engine becomes the default | [#58](https://github.com/leo1oel/lattice/pull/58) |
| Phase 3: Open Knowledge, its adapted files, vendoring scripts, locks and the differential harness are deleted; the scans below were run | [#59](https://github.com/leo1oel/lattice/pull/59) |

## Clean-room rules

The rules are recorded in full in [`visual-editor-spec.md`](visual-editor-spec.md#provenance-clean-room-rules). In short:

- The engine was written only from `docs/visual-editor-spec.md` plus the CommonMark 0.31 and GFM specifications.
- The spec itself was written only from allowed sources:
  - Lattice's own tests;
  - observed black-box behavior;
  - the saved-file formats Lattice writes;
  - Lattice's docs and message catalogs;
  - CommonMark and GFM.
  Each requirement cites its evidence.
- Never read: the vendored trees, the files adapted from Open Knowledge, its stylesheet, the vendoring script and log, and the upstream repository.
  - Upstream identifiers, class names, file structure and comments were not carried over.
  - The engine uses its own `lx-md-` CSS, written from Lattice's design tokens.
- Every engine file carries the header "Clean implementation for Lattice; spec: docs/visual-editor-spec.md".
- The only contact with the old editor was a black-box differential harness ([#55](https://github.com/leo1oel/lattice/pull/55)), deleted with it in [#59](https://github.com/leo1oel/lattice/pull/59). It compared what each editor showed and saved on the same corpus.
- `src/platform/clean-room-guard.test.ts` and an ESLint `no-restricted-imports` rule fail if Open Knowledge paths, packages or imports return.

## Similarity scan

- **Tool:** [copydetect](https://github.com/blingenf/copydetect) 0.5.0 (MIT), token-level winnowing, with `noise_t=25`, `guarantee_t=30` and `display_t=0`, over `ts`, `tsx` and `css`.
- **Scanned:** `src/editor/markdown/engine/` as of [#59](https://github.com/leo1oel/lattice/pull/59), 62 files with tests included.
- **References:**
  - Open Knowledge at commit `c234a9c6c85b9a911094f0840d77953db41545e6`, the commit the vendored trees were pinned to: 5,029 files, fetched into a temporary directory outside the repository and read only by the tool.
  - The 8 deleted Lattice files adapted from Open Knowledge, taken from git history.
- **Reading the scores:**
  - **engine** is the share of the engine file's tokens that match.
  - **ref** is the share of the reference file's tokens that match.

### Results

- **Against Open Knowledge:** the highest engine-side share was 0.33.
- **Against the deleted adapted files:** the highest engine-side share was 0.31.
- **Reference-side scores above 0.50** all fell on short files built from shared package-name imports or test boilerplate:
  - `packages/app/vite.dedupe.ts` (91 lines), where each engine file matched 0.02 or less of its own tokens;
  - `packages/app/tests/stress/_helpers/regexp.ts` (24 lines), at engine-side 0.01.
- **One exception**, `code-languages.ts`, is covered below.

### `code-languages.ts` was re-derived

Its hand-written language table matched OK's `packages/app/src/editor/extensions/code-block-languages.ts`. It was rewritten so that names and aliases come from highlight.js's own grammar registrations. Only Lattice's choices stay hand-written:
- the picker subset and its order;
- the tokens a pick writes;
- labels where highlight.js's differ;
- a short list of spellings Lattice's earlier table accepted.

| `code-languages.ts` vs `code-block-languages.ts` | engine | ref |
| --- | ---: | ---: |
| before | 0.23 | 0.56 |
| after | 0.01 | 0.02 |

After the rewrite, its highest pair against any Open Knowledge file is engine 0.01 / ref 0.24. It has no overlap with the deleted adapted files. The remaining pairs were reviewed on their scores and accepted as clean.

### All pairs with either side ≥ 0.30, against Open Knowledge @ c234a9c

Scanned before `code-languages.ts` was re-derived.

| engine | ref | engine file | reference file |
| ---: | ---: | --- | --- |
| 0.01 | 0.62 | `rich-blocks.test.ts` | `packages/app/vite.dedupe.ts` |
| 0.00 | 0.62 | `lattice-visual-blocks.test.tsx` | `packages/app/vite.dedupe.ts` |
| 0.01 | 0.57 | `markdown-document.test.ts` | `packages/app/vite.dedupe.ts` |
| 0.00 | 0.57 | `engine-schema.ts` | `packages/app/vite.dedupe.ts` |
| 0.00 | 0.57 | `lattice-visual-chrome.test.tsx` | `packages/app/vite.dedupe.ts` |
| 0.23 | 0.56 | `code-languages.ts` | `packages/app/src/editor/extensions/code-block-languages.ts` |
| 0.01 | 0.51 | `mdx-components.ts` | `packages/app/tests/stress/_helpers/regexp.ts` |
| 0.04 | 0.44 | `lattice-visual-blocks.test.tsx` | `packages/app/src/components/FeedbackCard.dom.test.tsx` |
| 0.05 | 0.40 | `lattice-visual-chrome.test.tsx` | `packages/app/src/components/FeedbackCard.dom.test.tsx` |
| 0.04 | 0.39 | `engine-schema.ts` | `packages/core/src/extensions/strike-fidelity.ts` |
| 0.05 | 0.39 | `lattice-visual-review.test.tsx` | `packages/app/src/components/FeedbackCard.dom.test.tsx` |
| 0.04 | 0.38 | `engine-schema.ts` | `packages/core/src/extensions/underline-fidelity.ts` |
| 0.02 | 0.37 | `chrome/link-chrome.tsx` | `packages/app/src/editor/link-preview/ExternalLinkPreviewCard.tsx` |
| 0.02 | 0.37 | `frozen-headers.ts` | `packages/core/src/extensions/plain-text-clipboard.ts` |
| 0.15 | 0.36 | `chrome/selection-toolbar.tsx` | `packages/app/src/editor/bubble-menu/BlockTypeSelector.tsx` |
| 0.08 | 0.36 | `chrome/slash-items.ts` | `packages/app/src/components/settings/settings-fields.ts` |
| 0.01 | 0.35 | `chrome/suggestion-menu.tsx` | `packages/app/src/components/files-section-reveal-store.ts` |
| 0.06 | 0.35 | `lattice-visual-passive.test.tsx` | `packages/app/src/components/FeedbackCard.dom.test.tsx` |
| 0.04 | 0.35 | `engine-schema.ts` | `packages/core/src/extensions/table-fidelity.ts` |
| 0.10 | 0.35 | `lattice-visual-chrome.test.tsx` | `packages/app/src/components/TerminalNewChatButton.dom.test.tsx` |
| 0.07 | 0.35 | `chrome/chrome-host.ts` | `packages/app/src/components/files-section-reveal-store.ts` |
| 0.12 | 0.34 | `lattice-visual-blocks.test.tsx` | `packages/app/src/components/TerminalNewChatButton.dom.test.tsx` |
| 0.10 | 0.33 | `lattice-visual-review.test.tsx` | `packages/app/src/components/TerminalNewChatButton.dom.test.tsx` |
| 0.06 | 0.33 | `views/footnote-views.tsx` | `packages/app/src/editor/extensions/heading-anchors.ts` |
| 0.04 | 0.33 | `source-overlays.ts` | `packages/app/src/editor/extensions/heading-anchors.ts` |
| 0.10 | 0.33 | `lattice-visual-chrome.test.tsx` | `packages/app/src/components/NewWorktreeDialog.dom.test.tsx` |
| 0.10 | 0.33 | `lattice-visual-chrome.css` | `packages/app/src/cmd-f.css` |
| 0.04 | 0.33 | `heading-anchors.ts` | `packages/app/src/editor/extensions/heading-anchors.ts` |
| 0.33 | 0.26 | `latex-math-syntax.ts` | `packages/core/src/markdown/wiki-link-micromark.ts` |
| 0.13 | 0.33 | `lattice-visual-blocks.test.tsx` | `packages/app/src/lib/locale-load-failure-notice.dom.test.tsx` |
| 0.06 | 0.32 | `code-highlight.ts` | `packages/app/src/editor/extensions/heading-anchors.ts` |
| 0.08 | 0.32 | `lattice-visual-blocks.test.tsx` | `packages/app/src/editor/link-path-suggestions.dom.test.tsx` |
| 0.06 | 0.32 | `lattice-visual-passive.test.tsx` | `packages/app/src/components/ImportSkillForm.dom.test.tsx` |
| 0.32 | 0.11 | `lattice-visual-blocks.css` | `packages/app/src/globals.css` |
| 0.12 | 0.32 | `lattice-visual-passive.test.tsx` | `packages/app/src/components/TerminalNewChatButton.dom.test.tsx` |
| 0.07 | 0.32 | `lattice-visual-chrome.test.tsx` | `packages/app/src/editor/link-path-suggestions.dom.test.tsx` |
| 0.09 | 0.31 | `lattice-visual-blocks.css` | `packages/app/src/cmd-f.css` |
| 0.05 | 0.31 | `lattice-visual-blocks.test.tsx` | `packages/app/src/components/empty-state/CopyablePromptList.dom.test.tsx` |
| 0.03 | 0.31 | `lattice-visual-blocks.test.tsx` | `packages/app/src/components/ImportSkillForm.dom.test.tsx` |
| 0.03 | 0.31 | `passive-view.tsx` | `packages/app/src/editor/extensions/heading-anchors.ts` |
| 0.01 | 0.30 | `mdx-components.ts` | `packages/core/src/markdown/reference-label.ts` |
| 0.14 | 0.30 | `lattice-visual-chrome.test.tsx` | `packages/app/src/components/TerminalTabStrip.dom.test.tsx` |
| 0.04 | 0.30 | `engine-schema.ts` | `packages/core/src/extensions/code-block-fidelity.ts` |

### All pairs with either side ≥ 0.30, against the deleted adapted files

Scanned before `code-languages.ts` was re-derived.

| engine | ref | engine file | reference file |
| ---: | ---: | --- | --- |
| 0.31 | 0.02 | `engine-node-views.tsx` | `visual-markdown-schema.ts` |

Engine file paths are relative to `src/editor/markdown/engine/`.

## Provenance scan

- **Tool:** [ScanCode Toolkit](https://github.com/aboutcode-org/scancode-toolkit) 32.5.0 (Apache-2.0), run as `scancode --copyright --license --package --info --processes 4 --timeout 300`.
- **Scope:** Lattice-owned code as of [#59](https://github.com/leo1oel/lattice/pull/59), 851 files: `src/` (without the message catalogs), `src-tauri/src/`, `scripts/`, `tools/`, `literature-worker/`, `video/`, `evals/`, `index.html` and `icon-lab.html`.

### Results

Every license and copyright detection is declared in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) or expected:
- MIT:
  - the Fluid Functionalism / Lina UI primitives in `src/components/ui/`;
  - the Open Slide `create-theme` skill;
  - `scripts/prepare-synara-sidecar.mjs`, which stages runtime license files.
- MIT and Apache-2.0: `src/project/project-file-icons.ts` (Material Icon Theme and Material Icons).
- OFL-1.1: the Ioskeley Mono font, and font license texts that tests assert.
- GPL-3.0-or-later: the `literature-worker` and `video` package license fields, since changed to Apache-2.0.
- License identifiers that `scripts/generate-notices.mjs` classifies.

**No undeclared third-party code was found.**
