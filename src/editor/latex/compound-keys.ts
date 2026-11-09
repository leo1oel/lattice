/**
 * chemnum compounds in LaTeX source and build output: the keys a source names
 * in `\cmpd` and its relatives, the number the last build gave each, and
 * whether a run of PDF text reads as a compound number.
 */

// No class here may cross a brace or bracket: one that can rescans to the end
// of the text from every `\cmpd[` or `\chemnum@cmpd {`, which is quadratic.
const COMPOUND_COMMAND = /\\(?:cmpd\*?|refcmpd|labelcmpd)(?:\[[^\][{}]*\])?\{([^{}]*)\}/g;
const MARK_COMMAND = /\\rcmpd\{([^{}]*)\}/g;
const UNESCAPED_COMMENT = /(?<!\\)%.*$/;
/** Sources are untrusted, and a key is written back into a document or the clipboard: nothing in one may be LaTeX. */
const SAFE_KEY = /^[^\\{}%#$&^~\r\n]{1,200}$/;
/** How many keys a project lists. */
const MAX_KEYS = 5000;

const isSafeKey = (key: string) => SAFE_KEY.test(key);

/** A format, only after a key and a sub: as in a drawing, `x.num` is the sub named `num`. */
const STYLE_SUFFIX = /(?<=^[^.]+\.[^.]+)\.(?:num|dash|letter)$/;

/** The key chemnum records a number under: `key.sub.num` is written, `key.sub` recorded. */
export const numberedKey = (key: string) => key.replace(STYLE_SUFFIX, "");

/** A run of PDF text as the number it may be: `(2a),` reads `2a`. */
export const printedNumber = (text: string) => text.trim().replace(/^[([]+/, "").replace(/[)\],.;:]+$/, "");

/** What chemnum numbered: `counterPrefixed` holds the keys whose `pre-label-code` prints a counter, such as `\\thechapter-`. */
export type CompoundNumbers = ReadonlyMap<string, string> & { counterPrefixed?: ReadonlySet<string> };

/** A printed counter and its separator, in front of a number set in the same run of text: the `1-` of `1-2a`. */
const COUNTER_PREFIX = /^(?:\d+|[ivxlc]+|[IVXLC]+|[A-Z])[-.]/;

/**
 * A run of PDF text without the counter in front, when the build gave some
 * compound such a prefix, which the `.aux` holds only as a macro; else "".
 */
export function withoutCounterPrefix(text: string, numbers: CompoundNumbers): string {
  if (!numbers.counterPrefixed?.size) return "";
  const number = printedNumber(text);
  return number.replace(COUNTER_PREFIX, "") === number ? "" : number.replace(COUNTER_PREFIX, "");
}

/**
 * Of the keys a source line names, those the last build numbered as the PDF
 * text reads. SyncTeX gives only the line, which also typesets citation
 * numbers, references and years: only a number the build gave one of its
 * compounds is one.
 */
export function keysNumbered(text: string, keys: readonly string[], numbers: CompoundNumbers): string[] {
  const number = printedNumber(text);
  const bare = withoutCounterPrefix(text, numbers);
  return number ? keys.filter((key) => {
    const assigned = numbers.get(numberedKey(key));
    return assigned === number || Boolean(bare && assigned === bare && numbers.counterPrefixed?.has(numberedKey(key)));
  }) : [];
}

/** What `\\rcmpd` names on `line`: the text of a drawing's `[[…]]` marks. */
export function compoundMarksOnLine(line: string): string[] {
  return [...line.replace(UNESCAPED_COMMENT, "").matchAll(MARK_COMMAND)].map((match) => match[1].trim()).filter(isSafeKey);
}

/** The distinct compound keys named on `line`, in order; a sub-compound keeps its `key.sub` form. */
export function compoundKeysOnLine(line: string): string[] {
  const source = line.replace(UNESCAPED_COMMENT, "");
  const keys = [
    ...[...source.matchAll(COMPOUND_COMMAND)].flatMap((match) => match[1].split(",")),
    ...compoundMarksOnLine(source),
  ];
  return [...new Set(keys.map((key) => key.trim()).filter(isSafeKey))];
}

/** The LaTeX that cites a compound in the text. */
export const compoundCommand = (key: string, isMark = false) => (
  isMark || /^[AaIi]:/.test(key) ? String.raw`\rcmpd{${key}}` : String.raw`\cmpd{${key}}`
);

/** Every distinct compound key the sources name, in order of first appearance. */
export function compoundKeysIn(sources: string[]): string[] {
  return [...new Set(sources.flatMap((source) => source.split(/\r?\n/).flatMap(compoundKeysOnLine)))].slice(0, MAX_KEYS);
}

const plainNumber = (value: string) => value.replace(/\\[A-Za-z@]+\s*/g, "").replace(/[{}]/g, "").trim();

/** A label part chemnum wrote to the `.aux`; one left as a macro (`\thechapter-`) is known only while typesetting. */
const labelPart = (value: string) => (value.includes("\\") ? "" : plainNumber(value));

/**
 * What chemnum wrote to an `.aux`: each key's label as printed, with its
 * prefix and suffix (`pre-label-code`, `post-label-code`), and `key.sub` with
 * the sub's letter after the number and any `post-main-label-code`.
 */
export function parseCompoundNumbers(aux: string): Map<string, string> & { counterPrefixed: Set<string> } {
  const counterPrefixed = new Set<string>();
  const numbers = Object.assign(new Map<string, string>(), { counterPrefixed });
  const parents = new Map<string, { head: string; separator: string; post: string }>();
  const compound = /\\chemnum@cmpd\s*\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{[^{}]*\}\{([^{}]*)\}/g;
  for (const [, key, counter, shown, pre, post, separator] of aux.matchAll(compound)) {
    const head = labelPart(pre) + (plainNumber(shown) || plainNumber(counter));
    if (/\\the[a-z]+/.test(pre)) counterPrefixed.add(key);
    parents.set(key, { head, separator: labelPart(separator), post: labelPart(post) });
    numbers.set(key, head + labelPart(post));
  }
  for (const [, key, sub, , letter] of aux.matchAll(/\\chemnum@subcmpd\s*\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}\{([^{}]*)\}/g)) {
    const parent = parents.get(key);
    if (!parent) continue;
    numbers.set(`${key}.${sub}`, parent.head + parent.separator + plainNumber(letter) + parent.post);
    if (counterPrefixed.has(key)) counterPrefixed.add(`${key}.${sub}`);
  }
  for (const [, series, key, label] of aux.matchAll(/\\cmpdser@aux\s*\{([AaIi])\}\{([^{}]*)\}\{([^{}]*)\}/g)) {
    numbers.set(`${series}:${key}`, plainNumber(label));
  }
  return numbers;
}

export type CompoundEntry = { key: string; number?: string };

/** The project's compounds: numbered ones in number order, then those no build has numbered yet by key. */
export function compoundEntries(keys: string[], numbers: Map<string, string>): CompoundEntry[] {
  const order = new Intl.Collator("en", { numeric: true });
  const styled = keys.filter((key) => STYLE_SUFFIX.test(key));
  // `key.sub.num` is the key a writer sees; chemnum records it as `key.sub`.
  const hidden = new Set(styled.map(numberedKey));
  return [...new Set([...keys, ...numbers.keys()])]
    .filter((key) => isSafeKey(key) && !hidden.has(key))
    .slice(0, MAX_KEYS)
    .map((key) => ({ key, number: numbers.get(numberedKey(key)) }))
    .sort((a, b) => (
      a.number && b.number ? order.compare(a.number, b.number)
        : a.number ? -1 : b.number ? 1 : order.compare(a.key, b.key)
    ));
}
