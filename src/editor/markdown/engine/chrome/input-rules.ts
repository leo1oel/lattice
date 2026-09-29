/**
 * Markdown typed into the visual engine that becomes structure as it is
 * typed (spec R-INL-3, R-BLK-19, R-FMT-14):
 *
 * - `[docs](https://example.com)` becomes a link when its `)` is typed.
 * - `[] `, `[ ] `, `[x] ` or `[X] ` at the start of a paragraph makes a task
 *   item, keeping an uppercase `X`. Typed after a fresh list marker
 *   (`- [ ] `, character by character or in one IME chunk), it turns that
 *   list into one task list rather than nesting a new one. Typed in a list
 *   item's continuation paragraph, it makes a new task item there without
 *   retagging the item above. Backspace right after reverts to the text.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension, InputRule } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { UPPERCASE_CHECK } from "../markdown-syntax";

const SAFE_HREF = /^(?![\s]*(?:javascript|vbscript|data|file):)\S+$/i;

const markdownLink = new InputRule({
  find: /(?:^|[^!\\])(\[([^[\]\n]+)\]\(([^()\s]+)\))$/,
  handler: ({ state, range, match }) => {
    const [, whole, text, href] = match;
    if (!whole || !text || !href || !SAFE_HREF.test(href)) return null;
    const start = range.from + (match[0].length - whole.length);
    const link = state.schema.marks.link!.create({ href });
    state.tr.replaceWith(start, range.to, state.schema.text(text, [...(state.doc.resolve(start).marks().filter((mark) => mark.type !== link.type)), link]));
    state.tr.removeStoredMark(link.type);
    return undefined;
  },
});

/** An optional list marker, then the task box: `- [ ] `, `* [x] `, `[] `. */
const TASK = /^\s*(?:[-*+]\s)?\[([ xX]?)\]\s$/;

const taskItem = new InputRule({
  find: TASK,
  handler: ({ state, range, match }) => {
    const $from = state.doc.resolve(range.from);
    const paragraph = $from.parent;
    // Only at the very start of a paragraph.
    if (paragraph.type.name !== "paragraph" || range.from !== $from.start()) return null;
    const box = match[1] ?? "";
    const attrs = { checked: box === "x" || box === UPPERCASE_CHECK, marker: box === UPPERCASE_CHECK ? UPPERCASE_CHECK : null };
    const { schema } = state;
    const tr = state.tr;
    const rest = paragraph.content.cut(range.to - $from.start());
    const item = schema.nodes.taskItem!.create(attrs, schema.nodes.paragraph!.create(null, rest));
    const depth = $from.depth;
    const container = depth > 1 ? $from.node(depth - 1) : null;
    const list = depth > 2 ? $from.node(depth - 2) : null;
    if (container && list && (container.type.name === "listItem" || container.type.name === "taskItem")) {
      const index = $from.index(depth - 1);
      const itemStart = $from.before(depth - 1);
      if (index === 0) {
        // The item's first paragraph: this item becomes the task item.
        const retagged = schema.nodes.taskItem!.create(attrs, Fragment.from(schema.nodes.paragraph!.create(null, rest)).append(container.content.cut(paragraph.nodeSize)));
        tr.replaceWith(itemStart, itemStart + container.nodeSize, retagged);
        const listStart = $from.before(depth - 2);
        const updated = tr.doc.nodeAt(listStart)!;
        if (updated.type.name === "bulletList" && everyChild(updated, "taskItem")) {
          tr.setNodeMarkup(listStart, schema.nodes.taskList, { bullet: updated.attrs.bullet, spread: updated.attrs.spread });
        }
        tr.setSelection(TextSelection.create(tr.doc, itemStart + 2));
        return undefined;
      }
      // A continuation paragraph: it leaves its item as a new task item right after it.
      const paragraphStart = $from.before(depth);
      tr.delete(paragraphStart, paragraphStart + paragraph.nodeSize);
      const after = tr.mapping.map(itemStart + container.nodeSize);
      tr.insert(after, item);
      tr.setSelection(TextSelection.create(tr.doc, after + 2));
      return undefined;
    }
    const start = $from.before(depth);
    tr.replaceWith(start, start + paragraph.nodeSize, schema.nodes.taskList!.create(null, item));
    tr.setSelection(TextSelection.create(tr.doc, start + 3));
    return undefined;
  },
  undoable: true,
});

function everyChild(node: PmNode, type: string): boolean {
  let every = true;
  node.forEach((child) => {
    if (child.type.name !== type) every = false;
  });
  return every;
}

export const EngineInputRules = Extension.create({
  name: "latticeInputRules",
  addInputRules: () => [markdownLink, taskItem],
});
