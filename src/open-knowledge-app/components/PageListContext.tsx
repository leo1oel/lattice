/**
 * Local seam — not upstream code.
 *
 * Upstream's PageListContext is fed by the OK server's `/api/pages` +
 * `/api/documents` lists and a refresh scheduler; this host has no such
 * endpoints. Vendored consumers use two hooks:
 *
 *   - LinkEditPopover: `usePageList()` → `{ pages, folderPaths, loading }`
 *     for internal-page link path suggestions.
 *   - SrcAutocomplete: `useOptionalPageList()?.assetPaths` for asset src
 *     completion.
 *
 * The seam serves a static empty snapshot: link editing works with no
 * internal-page suggestions, and asset autocomplete offers no entries.
 * (The host's own wiki-link suggestion popup is fed separately from
 * MarkdownWorkspaceIndex.)
 */
export interface PageListContextValue {
  pages: ReadonlySet<string>;
  folderPaths: ReadonlySet<string>;
  assetPaths: ReadonlySet<string>;
  loading: boolean;
  error: string | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const EMPTY_PAGE_LIST: PageListContextValue = {
  pages: EMPTY_SET,
  folderPaths: EMPTY_SET,
  assetPaths: EMPTY_SET,
  loading: false,
  error: null,
};

export function usePageList(): PageListContextValue {
  return EMPTY_PAGE_LIST;
}

export function useOptionalPageList(): PageListContextValue | null {
  return null;
}
