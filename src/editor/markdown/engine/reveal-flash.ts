/**
 * The mark a jump leaves on its target in the visual editor: the top-level
 * block it landed in, held and faded like the source editor's
 * (src/editor/editor-reveal.ts) and the PDF's SyncTeX mark. A decoration, not
 * a class set on the DOM, so a block the window redraws keeps it.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** How long the mark stays; kept in step with REVEAL_FLASH_MS in editor-reveal.ts and `.lx-reveal-flash`. */
export const REVEAL_FLASH_MS = 1600;

type Block = { from: number; to: number };

const revealFlashKey = new PluginKey<DecorationSet>("latticeRevealFlash");

export const RevealFlash = Extension.create({
  name: "latticeRevealFlash",
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key: revealFlashKey,
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, flash) {
        const block = transaction.getMeta(revealFlashKey) as Block | null | undefined;
        if (block === undefined) return flash.map(transaction.mapping, transaction.doc);
        return block
          ? DecorationSet.create(transaction.doc, [Decoration.node(block.from, block.to, { class: "lx-reveal-flash" })])
          : DecorationSet.empty;
      },
    },
    props: { decorations: (state) => revealFlashKey.getState(state) },
  })],
});

/** Mark the top-level block `from`…`to` with `transaction` (null clears the mark); never an undo step. */
export const setRevealFlash = (transaction: Transaction, block: Block | null) => (
  transaction.setMeta(revealFlashKey, block).setMeta("addToHistory", false)
);
