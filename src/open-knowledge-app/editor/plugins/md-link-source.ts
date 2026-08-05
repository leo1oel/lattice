/**
 * Local seam — not upstream code.
 *
 * Upstream `md-link-source.ts` resolves relative Markdown link targets
 * against the workspace page-list cache to underline broken links in
 * source-mode CodeMirror. The cache is a host-app service outside this
 * vendored tree; the nested CM inside rawMdxFallback works fine without
 * link resolution, so the factory returns an inert extension.
 */
import type { Extension } from '@codemirror/state';

export function createMdLinkSourceExtension(): Extension {
  return [];
}
