import type { Nodes, Root } from 'mdast';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { protectPattern } from './entity-ref-guard.ts';

const BACKSLASH_ESCAPE_PUA_MARK = '';

export const BACKSLASH_GUARD_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '\\', to: BACKSLASH_ESCAPE_PUA_MARK },
];

const BACKSLASH_ESCAPE_RE = /\\</g;

export function encodeBackslashEscapes(source: string): string {
  return protectPattern(source, BACKSLASH_ESCAPE_RE, (match) => {
    return `${BACKSLASH_ESCAPE_PUA_MARK}${match.slice(1)}`;
  });
}

export function restoreBackslashEscapesPlugin(): ReturnType<Plugin<[], Root>> {
  return (tree: Root) => {
    visit(tree, (node: Nodes) => {
      const rec = node as unknown as Record<string, unknown>;
      if (typeof rec.value === 'string' && rec.value.includes(BACKSLASH_ESCAPE_PUA_MARK)) {
        rec.value = (rec.value as string).split(BACKSLASH_ESCAPE_PUA_MARK).join('');
      }
      for (const key of ['url', 'title', 'alt'] as const) {
        const v = rec[key];
        if (typeof v === 'string' && v.includes(BACKSLASH_ESCAPE_PUA_MARK)) {
          rec[key] = v.split(BACKSLASH_ESCAPE_PUA_MARK).join('');
        }
      }
    });
  };
}
