/**
 * HtmlBlock custom node for source-text fidelity.
 *
 * Atom node that stores raw HTML block content verbatim.
 * In WYSIWYG, renders as raw source text (no rich preview).
 *
 * Markdown parsing/serialization is handled by the unified pipeline (packages/core/src/markdown/).
 */

import { Node } from '@tiptap/core';

const EMPTY_ANCHOR = /^<a\s+id="([A-Za-z][A-Za-z0-9_.:-]*)"><\/a>$/;

export function emptyMarkdownAnchorId(value: unknown): string | null {
  return typeof value === 'string' ? EMPTY_ANCHOR.exec(value)?.[1] ?? null : null;
}

export const HtmlBlockFidelity = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  priority: 60,

  addAttributes() {
    return {
      content: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-html-block]' }];
  },

  renderHTML({ node }) {
    const anchorId = emptyMarkdownAnchorId(node.attrs.content);
    if (anchorId) {
      return [
        'div',
        {
          'data-html-block': '',
          'data-markdown-anchor': '',
          id: anchorId,
          'aria-hidden': 'true',
          contenteditable: 'false',
          style: 'height: 0; overflow: hidden; pointer-events: none;',
        },
      ];
    }
    return ['div', { 'data-html-block': '', class: 'html-block' }, node.attrs.content];
  },
});
