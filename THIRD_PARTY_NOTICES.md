# Third-party notices

## Cuelume

Lattice uses [Cuelume](https://github.com/Danilaa1/cuelume) for synthesized interface sounds.

MIT License

Copyright (c) 2026 Daniel Belyi

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## tldraw

The board editor is built with the [tldraw SDK](https://github.com/tldraw/tldraw) (Apache-2.0 code, separate SDK license key required for production use; this project ships under a tldraw Hobby license). See https://tldraw.dev/legal/tldraw-license.

## Material Icons

The project file tree's board (pencil) icon is adapted from [Material Icons](https://github.com/google/material-design-icons), licensed under the Apache License, Version 2.0.

## Material Icon Theme

The project file tree includes adapted PDF, TeX, bibliography, and BibTeX style icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme).

The MIT License (MIT)

Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Open Knowledge visual editor prototype

The visual Markdown block controls and slash-command prototype include adapted portions of [Inkeep Open Knowledge](https://github.com/inkeep/open-knowledge) at commit `9e8a00e24c6eaea110b546758664aad0e7ebab7e`.

Upstream files adapted:

- `packages/app/src/editor/extensions/drag-handle.ts`
- `packages/app/src/editor/extensions/slash-command.ts`
- `packages/app/src/editor/extensions/suggestion-floating-ui.ts`
- `packages/app/src/editor/slash-command/SlashCommandMenu.tsx`
- `packages/app/src/editor/slash-command/items.tsx`
- `packages/app/src/editor/slash-command/apply-item.ts`
- `packages/app/src/editor/extensions/CodeBlockView.tsx`
- `packages/app/src/editor/extensions/code-block-meta.ts`
- `packages/app/src/editor/table-controls/TableCellHandles.tsx`
- `packages/app/src/editor/extensions/table-row-enter.ts`

These adapted portions are licensed under GPL-3.0-or-later.
They were modified on 2026-08-03 for Research Writer's Markdown schema, design tokens, and canonical history integration.
The CodeBlock adaptation keeps only the language, title, copy, and delete controls.
The table adaptation keeps the GFM-compatible selection controls and spreadsheet-style Enter behavior; app-store drag reordering and non-portable table features are omitted.

The complete upstream GPL license is available at https://github.com/inkeep/open-knowledge/blob/9e8a00e24c6eaea110b546758664aad0e7ebab7e/LICENSE.

## Open Knowledge vendored core (`src/open-knowledge-core/`)

`src/open-knowledge-core/` vendors the editor subset of `packages/core/src` from [Inkeep Open Knowledge](https://github.com/inkeep/open-knowledge) at the same commit `9e8a00e24c6eaea110b546758664aad0e7ebab7e`, licensed GPL-3.0-or-later (see `src/open-knowledge-core/LICENSE`).
Directories vendored verbatim: `markdown/` (including `lint/`, `rehype-plugins/`, `fixtures/`), `extensions/`, `registry/`, `constants/`, `comments/`, `utils/`, `types/`, plus `metrics/parse-health.ts`, `bridge/` (structural-freshness, pm-structural-equivalence, parse-equivalence, normalize, subsequence, tolerance-telemetry), `schemas/api/_shared.ts`, and `util/doc-name.ts`.
Files removed because they reference subsystems outside the vendored subset: `types/principal.ts`, `types/timeline.ts`, `utils/uninstall-feedback-submit.ts` (and their tests), and three constants tests that import upstream build scripts.
Local deviations, each marked with a "Local deviation from upstream" comment: `extensions/link-fidelity.ts` (adapts `addOptions` to @tiptap 3.29's `LinkOptions`), `utils/identity.test.ts` (runs under the node vitest environment), and the added `vendor-globals.d.ts` (`process` shim; this repo carries no `@types/node`).
