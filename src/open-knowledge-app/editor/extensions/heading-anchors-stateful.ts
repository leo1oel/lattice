/* Local seam — not upstream code.
 *
 * Stateful replacement for the vendored HeadingAnchors extension
 * (./heading-anchors.ts). Upstream computes its DecorationSet inside
 * `props.decorations(state)`, which ProseMirror calls on EVERY view update —
 * including caret-only transactions — so each arrow-key press walked the
 * whole document and rebuilt every heading decoration. On large Markdown
 * that was a per-caret-move O(document) cost.
 *
 * This version keeps the set in plugin state and rebuilds it only on
 * `tr.docChanged`. Caret-only transactions return the same DecorationSet
 * instance, so the view's decoration diff is a no-op. A full rebuild on doc
 * change (rather than mapping) is deliberate: slug de-duplication suffixes
 * (-1, -2, …) depend on document order globally, so editing one heading can
 * legitimately renumber later ones — mapped decorations would go stale.
 *
 * Decoration output is byte-identical to upstream's; only the recompute
 * frequency changes. If upstream adopts this shape, delete this seam and
 * re-vendor.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { getHeadingSlug } from './wiki-link-helpers';

export const headingAnchorsStatefulKey = new PluginKey<DecorationSet>('headingAnchorsStateful');

function buildHeadingDecorations(doc: ProseMirrorNode): DecorationSet {
  const decos: Decoration[] = [];
  const slugCounts = new Map<string, number>();

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const id = getHeadingSlug(node.textContent, slugCounts);
      if (!id) return;

      decos.push(Decoration.node(pos, pos + node.nodeSize, { id }));
    }
  });

  return DecorationSet.create(doc, decos);
}

/** Exported bare so the unit test can drive it with a plain EditorState. */
export function headingAnchorsStatefulPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: headingAnchorsStatefulKey,
    state: {
      init: (_config, state) => buildHeadingDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? buildHeadingDecorations(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return headingAnchorsStatefulKey.getState(state);
      },
    },
  });
}

export const HeadingAnchorsStateful = Extension.create({
  name: 'headingAnchors',

  addProseMirrorPlugins() {
    return [headingAnchorsStatefulPlugin()];
  },
});
