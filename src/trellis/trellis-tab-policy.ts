/**
 * Which document tabs a panel keeps.
 *
 * A quick look (a press or arrow key in the Project tree, Quick open, a
 * project search hit) opens its document as its panel's preview tab, its
 * title in italics, which the next quick look in that panel replaces instead
 * of adding a tab beside it. Working with the document keeps its tab: an
 * edit, a double-click on the tab or the tree row, dragging the tab, Keep
 * open or Pin in its menu, or opening it any other way (an agent, a build
 * problem, a link followed, a file just made).
 *
 * A panel whose strip has no room for another tab with its whole title
 * closes tabs for the one coming in, as the writer's own close would (see
 * trellis-document-tabs.tsx): its preview first, then the least recently
 * used. Never a pinned tab, the active document or one with unsaved changes;
 * with none of its tabs free to go, the strip squeezes and scrolls as before.
 *
 * Both marks are params of the file view, so they are saved and restored
 * with the layout. Eager, as the controller that holds it: nothing from
 * Trellis at runtime.
 */
import type { WorkspaceHandle } from "@danfessler/trellis";

/** A file view's params: its document, and whether its tab is a preview or pinned. */
export type FileParams = { key: string; preview?: boolean; pinned?: boolean };

/** A document tab as eviction weighs it, in strip order, with the room it takes in the strip. */
export type TabCandidate = { id: string; key: string; preview: boolean; pinned: boolean; width: number };

/**
 * The tabs to close to free `short` px of strip: a preview first, then the
 * least recently used (strip order among tabs never used this session),
 * never a pinned tab or one `held`. With too few free to go, all of those:
 * the strip is then as roomy as it can be.
 */
export function chooseEvictions(
  tabs: readonly TabCandidate[],
  short: number,
  { held, lastUsed }: { held: (key: string) => boolean; lastUsed: (key: string) => number },
): string[] {
  const order = tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => !tab.pinned && !held(tab.key))
    .sort((a, b) => Number(b.tab.preview) - Number(a.tab.preview) || lastUsed(a.tab.key) - lastUsed(b.tab.key) || a.index - b.index);
  const chosen: string[] = [];
  let freed = 0;
  for (const { tab } of order) {
    if (freed >= short) break;
    chosen.push(tab.id);
    freed += tab.width;
  }
  return chosen;
}

export class DocumentTabs {
  /** The document the last quick look asked for, until App's open of it lands. */
  private previewKey: string | null = null;
  private readonly used = new Map<string, number>();
  private clock = 0;

  constructor(private readonly workspace: () => WorkspaceHandle | null) {}

  /** The next open of `key` is a quick look: its tab opens as its panel's preview. */
  preview(key: string) {
    this.previewKey = key;
  }

  /**
   * What App's latest state means for the active document's tab, given the
   * last state the workspace reconciled: the writer opened it, by a quick
   * look or another way, or nothing did (a restore, a reconcile). App shows
   * a newly opened file by making it active and an open of one already in a
   * tab by its reveal, so either counts, but only once the tabs have settled.
   * A reveal that was no quick look keeps the tab. Each open ends the ask.
   */
  opening(
    now: { activeKey: string; tabsReady: boolean; revealRequest: number },
    last: { lastActive: string; lastReveal: number; lastTabsReady: boolean },
  ): "preview" | "open" | null {
    const revealed = now.revealRequest !== last.lastReveal;
    if (!now.tabsReady || !last.lastTabsReady || (!revealed && now.activeKey === last.lastActive)) return null;
    const quick = this.previewKey === now.activeKey;
    this.previewKey = null;
    if (quick) return "preview";
    if (revealed) this.keep(now.activeKey);
    return "open";
  }

  /** The document became the active one: the most recently used. */
  touch(key: string) {
    this.used.set(key, ++this.clock);
  }

  lastUsed = (key: string) => this.used.get(key) ?? 0;

  /**
   * Keep `key`'s tab: no longer a preview. A quick look still on its way
   * (the second press of a double-click lands before the file has read)
   * opens as a kept tab.
   */
  keep(key: string) {
    if (this.previewKey === key) this.previewKey = null;
    const ws = this.workspace();
    for (const view of ws?.views({ type: "file" }) ?? []) {
      if (view.params.key === key && view.params.preview) ws?.setParams(view.id, { preview: false });
    }
  }

  /** Pin or unpin a document tab; a pinned tab is kept too. */
  setPinned(viewId: string, pinned: boolean) {
    this.workspace()?.setParams(viewId, pinned ? { pinned, preview: false } : { pinned });
  }
}
