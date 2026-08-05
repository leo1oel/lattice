import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { FindMatchRange, FindOptions } from './find-types';

interface TextMatchRange {
  start: number;
  end: number;
  text: string;
}

const ASCII_WORD_RE = /[A-Za-z0-9_]/;

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && ASCII_WORD_RE.test(char);
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  return !isAsciiWordChar(text[start - 1]) && !isAsciiWordChar(text[end]);
}

export function findLiteralMatchesInText(
  text: string,
  query: string,
  options: FindOptions,
): TextMatchRange[] {
  if (query.length === 0) return [];

  const haystack = options.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: TextMatchRange[] = [];

  let searchFrom = 0;
  while (searchFrom <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) break;

    const end = index + needle.length;
    if (!options.wholeWord || isWholeWordMatch(text, index, end)) {
      matches.push({ start: index, end, text: text.slice(index, end) });
    }
    searchFrom = end;
  }

  return matches;
}

export function findLiteralMatchesInDoc(
  doc: ProseMirrorNode,
  query: string,
  options: FindOptions,
): FindMatchRange[] {
  if (query.length === 0) return [];

  const matches: FindMatchRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== 'string') return;
    for (const match of findLiteralMatchesInText(node.text, query, options)) {
      matches.push({
        from: pos + match.start,
        to: pos + match.end,
        text: match.text,
      });
    }
  });
  return matches;
}
