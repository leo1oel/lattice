/**
 * Local seam — not upstream code.
 *
 * Upstream `wiki-link-source.ts` decorates `[[wiki links]]` in nested
 * CodeMirror editors with completions ranked by the workspace link graph
 * and click-through navigation — both host-app services (page-list cache,
 * doc-hash routing, external-link opener) this vendored tree does not
 * carry. The nested CM inside rawMdxFallback only needs plain Markdown
 * editing here, so the factory returns an inert extension.
 */
import type { Extension } from '@codemirror/state';

export function createWikiLinkSourceExtension(_currentDocName: string | null): Extension {
  return [];
}
