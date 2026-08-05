import type { PhrasingContent, Root, Text } from 'mdast';
import type { InlineMath } from 'mdast-util-math';
import { SKIP, visit } from 'unist-util-visit';
import type { VFile } from 'vfile';
import {
  deriveFragmentPosition,
  escapedValueOffsets,
  isEscapeDerivedRun,
} from './promoter-position.ts';

const SINGLE_DOLLAR_MATH_RE = /(?<!\\)\$(?=\S)([^$\n]*?[^\s$])\$(?!\d)/g;

export function singleDollarMathPromoterPlugin() {
  return (tree: Root, file: VFile) => {
    const source = typeof file.value === 'string' ? file.value : '';
    visit(tree, 'text', (node: Text, index, parent) => {
      if (parent === undefined || index === undefined || index === null) return;

      const value = node.value;
      if (value.indexOf('$') === -1) return;

      const escaped = escapedValueOffsets(source, node);
      SINGLE_DOLLAR_MATH_RE.lastIndex = 0;
      const matches: RegExpExecArray[] = [];
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
      while ((m = SINGLE_DOLLAR_MATH_RE.exec(value)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (isEscapeDerivedRun(escaped, start, 1) || isEscapeDerivedRun(escaped, end - 1, 1)) {
          SINGLE_DOLLAR_MATH_RE.lastIndex = start + 1;
          continue;
        }
        matches.push(m);
      }
      if (matches.length === 0) return;

      const replacements: PhrasingContent[] = [];
      let cursor = 0;
      for (const match of matches) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > cursor) {
          const lead: Text = { type: 'text', value: value.slice(cursor, start) };
          const pos = deriveFragmentPosition(source, node, cursor, start);
          if (pos) lead.position = pos;
          replacements.push(lead);
        }
        const mathNode: InlineMath = {
          type: 'inlineMath',
          value: match[1],
          data: { sourceDelimiter: '$' },
        };
        const fullPos = deriveFragmentPosition(source, node, start, end);
        if (fullPos) mathNode.position = fullPos;
        replacements.push(mathNode as unknown as PhrasingContent);
        cursor = end;
      }
      if (cursor < value.length) {
        const tail: Text = { type: 'text', value: value.slice(cursor) };
        const pos = deriveFragmentPosition(source, node, cursor, value.length);
        if (pos) tail.position = pos;
        replacements.push(tail);
      }

      const arr = (parent as { children: PhrasingContent[] }).children;
      arr.splice(index, 1, ...replacements);
      return [SKIP, index + replacements.length];
    });

    // Let remark-math tokenize single-dollar spans before CommonMark can turn
    // LaTeX underscores into emphasis, then restore currency-like false
    // positives that the conservative promoter intentionally rejects.
    visit(tree, 'inlineMath', (node: InlineMath, index, parent) => {
      if (parent === undefined || index === undefined || index === null || !node.position) return;
      const start = node.position.start.offset;
      const end = node.position.end.offset;
      if (typeof start !== 'number' || typeof end !== 'number') return;
      const raw = source.slice(start, end);
      if (!/^\$(?!\$)[^]*\$(?!\$)$/.test(raw)) return;
      const body = raw.slice(1, -1);
      const safe = /^\S[^$\r\n]*\S$|^\S$/.test(body)
        && !/^\d/.test(source.slice(end))
        && source[start - 1] !== '\\';
      if (safe) return;
      const text: Text = { type: 'text', value: raw, position: node.position };
      const children = (parent as { children: PhrasingContent[] }).children;
      children.splice(index, 1, text);
      return [SKIP, index + 1];
    });
  };
}
