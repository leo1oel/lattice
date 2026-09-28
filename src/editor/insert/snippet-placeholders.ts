export type SnippetStop = {
  from: number;
  to: number;
};

export type ExpandedSnippet = {
  text: string;
  stops: SnippetStop[];
};

/** Expand `${1:label}` / `$1` style placeholders into plain text + tab stops. */
export function expandSnippetPlaceholders(insert: string): ExpandedSnippet {
  const stops = new Map<number, SnippetStop>();
  let text = "";
  let cursor = 0;
  for (const match of insert.matchAll(/\$\{([^}]*)\}|\$(\d+)/g)) {
    text += insert.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const body = match[1] ?? match[2];
    const colon = match[1] === undefined ? -1 : body.indexOf(":");
    const stop = Number(colon < 0 ? body : body.slice(0, colon));
    if (!Number.isInteger(stop) || stop < 0) {
      text += match[0];
      continue;
    }
    const from = text.length;
    text += colon < 0 ? "" : body.slice(colon + 1);
    if (!stops.has(stop)) stops.set(stop, { from, to: text.length });
  }
  text += insert.slice(cursor);
  const ordered = [...stops.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, stop]) => stop);
  return { text, stops: ordered };
}

const shifted = (stops: SnippetStop[], baseOffset: number): SnippetStop[] =>
  stops.map((stop) => ({ from: baseOffset + stop.from, to: baseOffset + stop.to }));

export function nextSnippetStop(stops: SnippetStop[], cursor: number, baseOffset: number): SnippetStop | null {
  const absolute = shifted(stops, baseOffset);
  return absolute.find((stop) => cursor < stop.to || (cursor === stop.from && stop.from === stop.to))
    ?? absolute[0]
    ?? null;
}

export function previousSnippetStop(stops: SnippetStop[], cursor: number, baseOffset: number): SnippetStop | null {
  const absolute = shifted(stops, baseOffset);
  return [...absolute].reverse().find((stop) => cursor > stop.to) ?? absolute[0] ?? null;
}
