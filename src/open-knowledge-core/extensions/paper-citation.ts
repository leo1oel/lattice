import { Node } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { renderInlineObjectText } from './input-rule-text.ts';

/** Only local paper-library links are citations; ordinary links remain text. */
export function isPaperCitationHref(href: string): boolean {
  return /^(?:\.\.?\/)*\.research\/papers\/[^/]+\/(?:paper|blog)\.md$/.test(href);
}

// The link mark owns the URL and its Markdown fidelity attrs. This leaf owns
// the label so cursor movement, selection, deletion and IME treat it atomically.
export const PaperCitation = Node.create({
  name: 'paperCitation',
  group: 'inline',
  inline: true,
  atom: true,
  marks: '_',
  addAttributes() {
    return { label: { default: '', rendered: false } };
  },
  parseHTML() {
    return [{
      tag: 'span[data-paper-citation]',
      getAttrs: (element) => ({ label: element.textContent ?? '' }),
    }];
  },
  renderHTML({ node }) {
    return ['span', { 'data-paper-citation': '', contenteditable: 'false' }, node.attrs.label];
  },
  renderText: renderInlineObjectText,
  extendNodeSchema(extension) {
    // TipTap binds `this.name` to the node being extended, not this extension.
    return extension.name === 'paperCitation'
      ? { leafText: (node: PmNode) => String(node.attrs.label) }
      : {};
  },
  addKeyboardShortcuts() {
    const remove = (backward: boolean) => {
      const { selection } = this.editor.state;
      if (!selection.empty) return false;
      const node = backward ? selection.$from.nodeBefore : selection.$from.nodeAfter;
      if (node?.type.name !== this.name) return false;
      return this.editor.commands.deleteRange({
        from: selection.from - (backward ? node.nodeSize : 0),
        to: selection.from + (backward ? 0 : node.nodeSize),
      });
    };
    return { Backspace: () => remove(true), Delete: () => remove(false) };
  },
});
