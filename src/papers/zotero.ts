/**
 * What the Zotero commands (src-tauri/src/zotero.rs) answer, and its
 * collections in the order Zotero's own tree shows them.
 */
export type ZoteroCollection = { key: string; name: string; parent: string | null; items: number };
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
