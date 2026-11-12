/**
 * What the Zotero command (src-tauri/lattice-core/src/zotero.rs) answers: one read of the
 * whole library, which the browser filters by folder here, so opening a folder
 * never reads the database again.
 */
export type ZoteroCollection = {
  key: string;
  name: string;
  parent: string | null;
};
/** One item: its BibTeX entry, its citation key, its PDF attachment's item key, and the collections it sits in directly. */
export type ZoteroItem = { bibtex: string; citationKey: string; pdf: string | null; collections: string[] };
/** The library Lattice found: its collections and its items. */
export type ZoteroLibrary = { collections: ZoteroCollection[]; items: ZoteroItem[] };

/** Each collection's direct subcollections, by key. */
function childrenOf(collections: readonly ZoteroCollection[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const collection of collections) {
    if (!collection.parent) continue;
    const siblings = children.get(collection.parent);
    if (siblings) siblings.push(collection.key);
    else children.set(collection.parent, [collection.key]);
  }
  return children;
}

/** `folder` and, with `includeSubfolders`, every collection below it. */
function folderKeys(children: ReadonlyMap<string, string[]>, folder: string, includeSubfolders: boolean): Set<string> {
  const keys = new Set([folder]);
  if (includeSubfolders) for (const key of keys) for (const child of children.get(key) ?? []) keys.add(child);
  return keys;
}

/**
 * The items a folder lists, each once: My Library ("") lists them all; a
 * folder its own, and with `includeSubfolders` those of every folder below it.
 */
export function folderItems(library: ZoteroLibrary, folder: string, includeSubfolders: boolean): ZoteroItem[] {
  if (!folder) return library.items;
  const keys = folderKeys(childrenOf(library.collections), folder, includeSubfolders);
  return library.items.filter((item) => item.collections.some((key) => keys.has(key)));
}

/** How many items each folder lists, by key, as `folderItems` lists them. */
export function folderCounts(library: ZoteroLibrary, includeSubfolders: boolean): Map<string, number> {
  const direct = new Map<string, ZoteroItem[]>();
  for (const item of library.items) {
    for (const key of item.collections) {
      const listed = direct.get(key);
      if (listed) listed.push(item);
      else direct.set(key, [item]);
    }
  }
  const children = childrenOf(library.collections);
  return new Map(library.collections.map((collection) => {
    const listed = new Set<ZoteroItem>();
    for (const key of folderKeys(children, collection.key, includeSubfolders)) {
      for (const item of direct.get(key) ?? []) listed.add(item);
    }
    return [collection.key, listed.size];
  }));
}

/** The collections in tree order, each with its depth; a parent Zotero did not list puts its children at the top. */
export function collectionTree(collections: readonly ZoteroCollection[]): Array<ZoteroCollection & { depth: number }> {
  const keys = new Set(collections.map((collection) => collection.key));
  const children = new Map<string | null, ZoteroCollection[]>();
  for (const collection of collections) {
    const parent = collection.parent && keys.has(collection.parent) ? collection.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), collection]);
  }
  const ordered: Array<ZoteroCollection & { depth: number }> = [];
  const visit = (parent: string | null, depth: number) => {
    for (const collection of children.get(parent) ?? []) {
      ordered.push({ ...collection, depth });
      visit(collection.key, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export type FolderRow = ZoteroCollection & { depth: number; hasChildren: boolean; expanded: boolean };

/**
 * The folder rows to draw: the tree with only `expanded` folders opened, or,
 * for a search, every folder whose name holds `query` with the folders above
 * it, opened so each match shows.
 */
export function folderRows(collections: readonly ZoteroCollection[], expanded: ReadonlySet<string>, query: string): FolderRow[] {
  const tree = collectionTree(collections);
  const parents = new Set(tree.map((collection) => collection.parent).filter((key): key is string => Boolean(key)));
  const needle = query.trim().toLocaleLowerCase();
  if (needle) {
    const byKey = new Map(tree.map((collection) => [collection.key, collection]));
    const shown = new Set<string>();
    for (const collection of tree) {
      if (!collection.name.toLocaleLowerCase().includes(needle)) continue;
      for (let at: (typeof tree)[number] | undefined = collection; at && !shown.has(at.key); at = at.parent ? byKey.get(at.parent) : undefined) {
        shown.add(at.key);
      }
    }
    return tree.filter((collection) => shown.has(collection.key))
      .map((collection) => ({ ...collection, hasChildren: parents.has(collection.key), expanded: true }));
  }
  const rows: FolderRow[] = [];
  let hiddenBelow = Infinity;
  for (const collection of tree) {
    if (collection.depth > hiddenBelow) continue;
    hiddenBelow = Infinity;
    const open = expanded.has(collection.key);
    rows.push({ ...collection, hasChildren: parents.has(collection.key), expanded: open });
    if (!open) hiddenBelow = collection.depth;
  }
  return rows;
}
