/** Stateless TipTap extensions the Lattice host adds around the vendored editor. */
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { NodeSelection, Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  activeChunkDecorationPlugin,
  chunkWrapperDecorationPlugin,
} from "@ok-app/editor/extensions/chunk-wrapper-decoration";
import { FrozenTableHeaders } from "@ok-app/editor/extensions/frozen-table-headers";

type PmNode = Editor["state"]["doc"];

export const ChunkWrapperDecoration = Extension.create({
  name: "chunkWrapperDecoration",
  addProseMirrorPlugins: () => [chunkWrapperDecorationPlugin(), activeChunkDecorationPlugin()],
});

const hasInternalAnchor = (list: PmNode) => {
  let found = false;
  list.descendants((node) => {
    found ||= node.isText && node.marks.some((mark) => (
      mark.type.name === "link" && typeof mark.attrs.href === "string" && mark.attrs.href.startsWith("#")
    ));
    return !found;
  });
  return found;
};

function generatedPaperContentsDecorations(doc: PmNode): DecorationSet {
  const decorations: Decoration[] = [];
  const attributes = { class: "visual-generated-paper-contents", "aria-hidden": "true" };
  let position = 0;
  for (let index = 0; index < doc.childCount - 1; index += 1) {
    const heading = doc.child(index);
    const list = doc.child(index + 1);
    if (
      heading.type.name === "heading"
      && heading.attrs.level === 2
      && heading.textContent.trim().toLocaleLowerCase() === "contents"
      && list.type.name === "list"
      && hasInternalAnchor(list)
    ) {
      const listStart = position + heading.nodeSize;
      decorations.push(
        Decoration.node(position, listStart, attributes),
        Decoration.node(listStart, listStart + list.nodeSize, attributes),
      );
    }
    position += heading.nodeSize;
  }
  return DecorationSet.create(doc, decorations);
}

/** Keep the imported Contents bytes editable while omitting that redundant block from paper previews. */
export const GeneratedPaperContents = Extension.create({
  name: "generatedPaperContents",
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    state: {
      init: (_config, state) => generatedPaperContentsDecorations(state.doc),
      apply: (transaction, value) => transaction.docChanged ? generatedPaperContentsDecorations(transaction.doc) : value,
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  })],
});

// The vendored editor normally renders a 56px toolbar over its document
// scroller. Lattice hosts the visual editor without that toolbar, so pin table
// headers to the actual viewport edge and do not paint the toolbar occluder.
export const LatticeFrozenTableHeaders = FrozenTableHeaders.configure({ topOffset: 0, occludeTop: false });

/** Delete/Backspace remove a selected atom (a horizontal rule, a figure) as one unit. */
export const AtomicBlockSelection = Extension.create({
  name: "atomicBlockSelection",
  addKeyboardShortcuts() {
    const remove = ({ editor }: { editor: Editor }) => (
      editor.state.selection instanceof NodeSelection && editor.commands.deleteSelection()
    );
    return { Delete: remove, Backspace: remove };
  },
});

export const CalloutEnterGuard = Extension.create({
  name: "calloutEnterGuard",
  priority: 110,
  addKeyboardShortcuts: () => ({
    Enter: ({ editor }) => {
      const { $from } = editor.state.selection;
      if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== "") return false;
      for (let depth = $from.depth - 1; depth >= 1; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name !== "jsxComponent") continue;
        // Open Knowledge treats Enter in an empty trailing container paragraph
        // as "exit component". During macOS IME commit, Chinese glyphs can
        // already be visible while PM still observes that paragraph as empty
        // for this keydown. Split in place so the Callout cannot collapse into
        // an empty selected atom.
        return node.attrs.componentName === "Callout" && editor.commands.splitBlock();
      }
      return false;
    },
  }),
  addProseMirrorPlugins: () => [new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      const paragraph = newState.schema.nodes.paragraph;
      if (!paragraph || !transactions.some((transaction) => transaction.docChanged)) return null;
      const emptyCallouts: number[] = [];
      newState.doc.descendants((node, position) => {
        if (node.type.name === "jsxComponent" && node.attrs.componentName === "Callout" && node.childCount === 0) {
          emptyCallouts.push(position);
        }
      });
      if (!emptyCallouts.length) return null;
      const transaction = newState.tr;
      for (const position of emptyCallouts.reverse()) transaction.insert(position + 1, paragraph.create());
      return transaction;
    },
  })],
});
