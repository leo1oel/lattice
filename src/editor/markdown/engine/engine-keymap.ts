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
import { moveDownOrAppendRow } from "./table-commands";

/** Containers whose empty last paragraph stays inside on Enter. */
const KEEPS_ENTER = new Set(["latticeComponent", "latticeFootnote"]);
const NEEDS_BODY = new Set(["Callout", "Accordion"]);

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
      if (!transactions.some((transaction) => transaction.docChanged)) return null;
      const empty: number[] = [];
      state.doc.descendants((node, position) => {
        if (node.type.name === "latticeComponent" && NEEDS_BODY.has(String(node.attrs.name)) && node.childCount === 0) empty.push(position);
        return !node.isTextblock;
      });
      if (!empty.length) return null;
      const transaction = state.tr;
      for (const position of empty.reverse()) transaction.insert(position + 1, state.schema.nodes.paragraph!.create());
      return transaction;
    },
  })],
});
