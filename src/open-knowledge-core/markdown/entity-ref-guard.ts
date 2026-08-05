import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Nodes, Root } from 'mdast';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';

const ENTITY_REF_PUA_OPEN = '';
const ENTITY_REF_PUA_CLOSE = '';

export const ENTITY_REF_GUARD_SUBSTITUTIONS: ReadonlyArray<{ from: string; to: string }> = [
  { from: '&', to: ENTITY_REF_PUA_OPEN },
  { from: ';', to: ENTITY_REF_PUA_CLOSE },
];

const ENTITY_REF_RE = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/g;

function countPrecedingBackslashes(source: string, before: number): number {
  let bs = 0;
  for (let i = before - 1; i >= 0 && source[i] === '\\'; i--) bs++;
  return bs;
}

export function protectPattern(
  source: string,
  pattern: RegExp,
  replace: (match: string) => string,
): string {
  pattern.lastIndex = 0;
  return source.replace(pattern, (match, offset) => {
    if (typeof offset !== 'number') return match;
    if (countPrecedingBackslashes(source, offset) % 2 === 1) return match;
    return replace(match);
  });
}

export function decodeEntityRefs(value: string): string {
  ENTITY_REF_RE.lastIndex = 0;
  return value.replace(ENTITY_REF_RE, (match) => {
    const body = match.slice(1, -1);
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      return decodeNumericCharacterReference(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    }
    const decoded = decodeNamedCharacterReference(body);
    return decoded === false ? match : decoded;
  });
}

export function encodeEntityRefs(source: string): string {
  return protectPattern(source, ENTITY_REF_RE, (match) => {
    const body = match.slice(1, -1);
    return `${ENTITY_REF_PUA_OPEN}${body}${ENTITY_REF_PUA_CLOSE}`;
  });
}

const ENCODED_ENTITY_RE = new RegExp(
  `${ENTITY_REF_PUA_OPEN}([^${ENTITY_REF_PUA_CLOSE}]+)${ENTITY_REF_PUA_CLOSE}`,
  'g',
);

interface EntityRefSpan {
  offset: number;
  length: number;
  raw: string;
}

function restoreEntityRefsInString(s: string): {
  value: string;
  spans: EntityRefSpan[];
} {
  if (!s.includes(ENTITY_REF_PUA_OPEN)) return { value: s, spans: [] };
  const spans: EntityRefSpan[] = [];
  let result = '';
  let cursor = 0;
  ENCODED_ENTITY_RE.lastIndex = 0;
  let match: RegExpExecArray | null = ENCODED_ENTITY_RE.exec(s);
  while (match !== null) {
    if (match.index > cursor) {
      result += s.slice(cursor, match.index);
    }
    const body = match[1] ?? '';
    const raw = `&${body};`;
    spans.push({ offset: result.length, length: raw.length, raw });
    result += raw;
    cursor = match.index + match[0].length;
    match = ENCODED_ENTITY_RE.exec(s);
  }
  if (cursor < s.length) {
    result += s.slice(cursor);
  }
  return { value: result, spans };
}

export function restoreEntityRefsPlugin(): ReturnType<Plugin<[], Root>> {
  return (tree: Root) => {
    visit(tree, (node: Nodes) => {
      const rec = node as unknown as Record<string, unknown>;
      if (typeof rec.value === 'string' && rec.value.includes(ENTITY_REF_PUA_OPEN)) {
        const { value, spans } = restoreEntityRefsInString(rec.value);
        rec.value = value;
        if (node.type === 'text' && spans.length > 0) {
          const textNode = node as { data?: Record<string, unknown> };
          textNode.data ??= {};
          textNode.data.entityRefSpans = spans;
        }
      }
      for (const key of ['url', 'title', 'alt', 'lang', 'meta'] as const) {
        const v = rec[key];
        if (typeof v === 'string' && v.includes(ENTITY_REF_PUA_OPEN)) {
          rec[key] = restoreEntityRefsInString(v).value;
        }
      }
    });
  };
}
