/**
 * chemnum compounds in LaTeX source and build output: the keys a source names
 * in `\cmpd` and its relatives, the number the last build gave each, and
 * whether a run of PDF text reads as a compound number.
 */

const COMPOUND_NUMBER = /^(?:[A-Z]{0,3}\d+(?:[.-]\d+)*[a-z]*|[A-Za-z]|[IVXLC]+[a-z]?|[ivxlc]{2,})$/;
const COMPOUND_COMMAND = /\\(?:cmpd\*?|refcmpd|labelcmpd)(?:\[[^\]]*\])?\{([^{}]*)\}/g;
const MARK_COMMAND = /\\rcmpd\{([^{}]*)\}/g;
const UNESCAPED_COMMENT = /(?<!\\)%.*$/;
/** Sources are untrusted, and a key is written back into a document or the clipboard: nothing in one may be LaTeX. */
const SAFE_KEY = /^[^\\{}%#$&^~\r\n]{1,200}$/;
/** How many keys a project lists. */
const MAX_KEYS = 5000;

const isSafeKey = (key: string) => SAFE_KEY.test(key);

/** Whether `text` is one number such as 1, 2a, 3.1, 4-2 or IV, punctuation around it aside. */
export function looksLikeCompoundNumber(text: string): boolean {
  return COMPOUND_NUMBER.test(text.trim().replace(/^[([]+/, "").replace(/[)\],.;:]+$/, ""));
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

/** Whether `text` is one letter, which only a series of small letters writes. */
export const isLoneSmallLetter = (text: string) => /^[a-z]$/.test(text.trim());

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
export function parseCompoundNumbers(aux: string): Map<string, string> {
  const numbers = new Map<string, string>();
  const parents = new Map<string, { head: string; separator: string; post: string }>();
  const compound = /\\chemnum@cmpd\s*\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{[^{}]*\}\{([^{}]*)\}/g;
  for (const [, key, counter, shown, pre, post, separator] of aux.matchAll(compound)) {
    const head = labelPart(pre) + (plainNumber(shown) || plainNumber(counter));
    parents.set(key, { head, separator: labelPart(separator), post: labelPart(post) });
    numbers.set(key, head + labelPart(post));
  }
  for (const [, key, sub, , letter] of aux.matchAll(/\\chemnum@subcmpd\s*\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g)) {
    const parent = parents.get(key);
    if (parent) numbers.set(`${key}.${sub}`, parent.head + parent.separator + plainNumber(letter) + parent.post);
  }
  for (const [, series, key, label] of aux.matchAll(/\\cmpdser@aux\s*\{([AaIi])\}\{([^}]*)\}\{([^}]*)\}/g)) {
    numbers.set(`${series}:${key}`, plainNumber(label));
  }
  return numbers;
}

/** A format, only after a key and a sub: as in a drawing, `x.num` is the sub named `num`. */
const STYLE_SUFFIX = /(?<=^[^.]+\.[^.]+)\.(?:num|dash|letter)$/;

export type CompoundEntry = { key: string; number?: string };

/** The project's compounds: numbered ones in number order, then those no build has numbered yet by key. */
export function compoundEntries(keys: string[], numbers: Map<string, string>): CompoundEntry[] {
  const order = new Intl.Collator("en", { numeric: true });
  const styled = keys.filter((key) => STYLE_SUFFIX.test(key));
  // `key.sub.num` is the key a writer sees; chemnum records it as `key.sub`.
  const hidden = new Set(styled.map((key) => key.replace(STYLE_SUFFIX, "")));
  return [...new Set([...keys, ...numbers.keys()])]
    .filter((key) => isSafeKey(key) && !hidden.has(key))
    .slice(0, MAX_KEYS)
    .map((key) => ({ key, number: numbers.get(key.replace(STYLE_SUFFIX, "")) }))
    .sort((a, b) => (
      a.number && b.number ? order.compare(a.number, b.number)
        : a.number ? -1 : b.number ? 1 : order.compare(a.key, b.key)
    ));
}
