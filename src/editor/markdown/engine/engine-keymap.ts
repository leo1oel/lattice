/**
 * Keyboard behavior of the visual engine's rich blocks (spec R-BLK-1,
 * R-BLK-7, R-BLK-11, R-PUB-18):
 *
 * - Enter never acts on the Enter that commits an IME candidate.
 * - In a table, Enter moves down the column and appends a row at the bottom.
 * - In a callout, accordion or footnote, Enter in an empty last paragraph adds
 *   a paragraph instead of leaving the block.
 * - Mod-Enter leaves a code block, where Enter only adds lines.
 * - A callout or accordion an edit empties gets an empty paragraph back.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { changedBlockRanges } from "./changed-ranges";
import { COMPONENTS_WITH_BODY } from "./mdx-components";
import { moveDownOrAppendRow } from "./table-commands";

/** Containers whose empty last paragraph stays inside on Enter. */
const KEEPS_ENTER = new Set(["latticeComponent", "latticeFootnote"]);

export type ImeGuard = { composingUntil: number };

export const EngineKeymap = Extension.create<{ ime: ImeGuard }>({
  name: "latticeEngineKeymap",
  priority: 1000,
  addOptions: () => ({ ime: { composingUntil: 0 } }),
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        // WebKit can deliver the Enter that commits a candidate right after compositionend.
        if (editor.view.composing || performance.now() < this.options.ime.composingUntil) return true;
        const { state } = editor;
        if (moveDownOrAppendRow(state, undefined)) return moveDownOrAppendRow(state, editor.view.dispatch);
        const { $from, empty } = state.selection;
        const parent = $from.parent;
        if (!empty || parent.type.name !== "paragraph" || parent.content.size) return false;
        const container = $from.node(-1);
        if (!container || !KEEPS_ENTER.has(container.type.name) || $from.index(-1) !== container.childCount - 1) return false;
        const after = $from.after();
        const transaction = state.tr.insert(after, state.schema.nodes.paragraph!.create());
        editor.view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, after + 1)).scrollIntoView());
        return true;
      },
      "Mod-Enter": ({ editor }) => (editor.state.selection.$from.parent.type.name === "codeBlock" ? editor.commands.exitCode() : false),
    };
  },
  addProseMirrorPlugins: () => [new Plugin({
    key: new PluginKey("latticeComponentRepair"),
    appendTransaction(transactions, _old, state) {
      const changed = transactions.filter((transaction) => transaction.docChanged);
      if (!changed.length) return null;
      // Only the blocks the edit touched can have been emptied; map their ranges to the final state.
      const empty = new Set<number>();
      for (const transaction of changed) {
        const rest = transactions.slice(transactions.indexOf(transaction) + 1);
        for (const range of changedBlockRanges(transaction)) {
          let { from, to } = range;
          for (const later of rest) {
            from = later.mapping.map(from, -1);
            to = later.mapping.map(to, 1);
          }
          state.doc.nodesBetween(from, Math.min(to, state.doc.content.size), (node, position) => {
            if (node.type.name === "latticeComponent" && COMPONENTS_WITH_BODY.has(String(node.attrs.name)) && node.childCount === 0) empty.add(position);
            return !node.isTextblock;
          });
        }
      }
      if (!empty.size) return null;
      const transaction = state.tr;
      for (const position of [...empty].sort((left, right) => right - left)) transaction.insert(position + 1, state.schema.nodes.paragraph!.create());
      return transaction;
    },
  })],
});
