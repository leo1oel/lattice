/**
 * What the Zotero commands (src-tauri/src/zotero.rs) answer, and its
 * collections in the order Zotero's own tree shows them.
 */
export type ZoteroCollection = {
  key: string;
  name: string;
  parent: string | null;
  /** Papers directly in it. */
  items: number;
  /** Papers in it or in any folder below it, each counted once. */
  total: number;
};
/** The library Lattice found: its data folder and its collections. */
export type ZoteroLibrary = { dataDir: string; collections: ZoteroCollection[] };
/** One item: its BibTeX entry, its citation key, and its PDF attachment's item key. */
export type ZoteroItem = { bibtex: string; citationKey: string; pdf: string | null };

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
