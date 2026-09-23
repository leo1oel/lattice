export type SourceQuoteRange = { from: number; to: number };

type NormalizedText = {
  text: string;
  starts: number[];
  ends: number[];
};

const WHITE_SPACE = /\s/u;

function normalizeWithOffsets(value: string): NormalizedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let offset = 0; offset < value.length;) {
    const codePoint = value.codePointAt(offset)!;
    const character = String.fromCodePoint(codePoint);
    const next = offset + character.length;

    // A hyphen immediately before an actual line ending is layout, not prose.
    // Don't remove ordinary hyphen-space sequences because that would make the
    // matcher guess at author punctuation.
    if (character === "-") {
      const lineBreak = value.slice(next).match(/^[\t \f\v]*\r?\n[\s]*/u);
      if (lineBreak) {
        offset = next + lineBreak[0].length;
        continue;
      }
    }

    if (WHITE_SPACE.test(character)) {
      let end = next;
      while (end < value.length) {
        const following = String.fromCodePoint(value.codePointAt(end)!);
        if (!WHITE_SPACE.test(following)) break;
        end += following.length;
      }
      if (text && text.at(-1) !== " ") {
        text += " ";
        starts.push(offset);
        ends.push(end);
      }
      offset = end;
      continue;
    }

    const normalizedCharacter = character.normalize("NFKC");
    for (let index = 0; index < normalizedCharacter.length; index += 1) {
      text += normalizedCharacter[index];
      starts.push(offset);
      ends.push(next);
    }
    offset = next;
  }

  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

/**
 * Finds exactly one range delimited by `first` and `last` after normalizing
 * whitespace, compatibility ligatures, and line-end hyphenation. Returned
 * offsets always address the original JavaScript string (UTF-16). Ambiguous
 * delimiters, empty delimiters, and missing delimiters return null. The two
 * delimiters may overlap.
 */
export function findSourceQuote(text: string, first: string, last: string): SourceQuoteRange | null {
  const haystack = normalizeWithOffsets(text);
  const firstNeedle = normalizeWithOffsets(first).text;
  const lastNeedle = normalizeWithOffsets(last).text;
  if (!firstNeedle || !lastNeedle || !haystack.text) return null;

  const ranges = new Map<string, SourceQuoteRange>();
  for (let firstAt = haystack.text.indexOf(firstNeedle); firstAt >= 0; firstAt = haystack.text.indexOf(firstNeedle, firstAt + 1)) {
    for (let lastAt = haystack.text.indexOf(lastNeedle, firstAt); lastAt >= 0; lastAt = haystack.text.indexOf(lastNeedle, lastAt + 1)) {
      const normalizedEnd = Math.max(firstAt + firstNeedle.length, lastAt + lastNeedle.length);
      const range = {
        from: haystack.starts[firstAt],
        to: haystack.ends[normalizedEnd - 1],
      };
      ranges.set(`${range.from}:${range.to}`, range);
      if (ranges.size > 1) return null;
    }
  }
  return ranges.values().next().value ?? null;
}

/** Preserve real line/block boundaries, which textContent omits at <br>. */
export function sourceQuoteDomRange(root: HTMLElement, first: string, last: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const segments: Array<{ node: Text; from: number; to: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      segments.push({ node, from: text.length, to: text.length + node.data.length });
      text += node.data;
    } else if (node instanceof Element && /^(BR|P|DIV|LI|H[1-6])$/.test(node.tagName)) {
      text += "\n";
    }
  }
  const match = findSourceQuote(text, first, last);
  if (!match) return null;
  const start = segments.find(segment => segment.from <= match.from && segment.to > match.from);
  const end = segments.find(segment => segment.from < match.to && segment.to >= match.to);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, match.from - start.from);
  range.setEnd(end.node, match.to - end.from);
  return range;
}
