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
  let index = 0;
  while (index < insert.length) {
    if (insert[index] !== "$") {
      text += insert[index];
      index += 1;
      continue;
    }
    if (insert[index + 1] === "{") {
      const close = insert.indexOf("}", index + 2);
      if (close < 0) {
        text += "$";
        index += 1;
        continue;
      }
      const body = insert.slice(index + 2, close);
      const colon = body.indexOf(":");
      const numberPart = colon >= 0 ? body.slice(0, colon) : body;
      const placeholder = colon >= 0 ? body.slice(colon + 1) : "";
      const stopIndex = Number(numberPart);
      if (!Number.isInteger(stopIndex) || stopIndex < 0) {
        text += insert.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      const from = text.length;
      text += placeholder;
      if (!stops.has(stopIndex)) stops.set(stopIndex, { from, to: text.length });
      index = close + 1;
      continue;
    }
    const digits = insert.slice(index + 1).match(/^\d+/);
    if (digits) {
      const stopIndex = Number(digits[0]);
      const from = text.length;
      if (!stops.has(stopIndex)) stops.set(stopIndex, { from, to: from });
      index += 1 + digits[0].length;
      continue;
    }
    text += "$";
    index += 1;
  }
  const ordered = [...stops.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, stop]) => stop);
  return { text, stops: ordered };
}

export function nextSnippetStop(
  stops: SnippetStop[],
  cursor: number,
  baseOffset: number,
): SnippetStop | null {
  const absolute = stops.map((stop) => ({
    from: baseOffset + stop.from,
    to: baseOffset + stop.to,
  }));
  return absolute.find((stop) => cursor < stop.to || (cursor === stop.from && stop.from === stop.to))
    ?? absolute[0]
    ?? null;
}

export function previousSnippetStop(
  stops: SnippetStop[],
  cursor: number,
  baseOffset: number,
): SnippetStop | null {
  const absolute = stops.map((stop) => ({
    from: baseOffset + stop.from,
    to: baseOffset + stop.to,
  }));
  for (let index = absolute.length - 1; index >= 0; index -= 1) {
    const stop = absolute[index];
    if (cursor > stop.to) return stop;
  }
  return absolute[0] ?? null;
}
