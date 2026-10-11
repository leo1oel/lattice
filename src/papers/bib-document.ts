/**
 * A .bib file as the visual bibliography editor reads and edits it: every
 * entry, field and `@string` macro with the exact source span it came from.
 *
 * Edits are splices into those spans, never a reserialization, so whatever an
 * edit does not touch (the writer's indentation and alignment, `%` comments,
 * text between entries, `@preamble`, `@comment`, other entries) stays
 * byte-for-byte as written. Braces are counted the way BibTeX counts them,
 * literally: `\{` is a brace like any other.
 */
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { paperAuthorNames, paperShortAuthors } from "./paper-identity";
import { explicitArxivId } from "./arxiv-id";

export type BibField = {
  /** The field name as written. */
  name: string;
  /** The name's first character. */
  from: number;
  /** The value: one or more parts joined by `#`, as written. */
  valueFrom: number;
  valueTo: number;
};

export type BibEntry = {
  /** The entry type as written ("Article"); compare with `kind`. */
  type: string;
  kind: string;
  key: string;
  /** The `@`. */
  from: number;
  /** One past the closing delimiter. */
  to: number;
  typeFrom: number;
  keyFrom: number;
  keyTo: number;
  fields: BibField[];
  /** A comma follows the last field (or the key, in an entry without fields). */
  trailingComma: boolean;
  /** 1-based line of the `@`. */
  line: number;
};

export type BibDocument = {
  entries: BibEntry[];
  /** `@string` macros by lower-cased name, each a raw value. */
  macros: Map<string, string>;
};

export type BibParseError = {
  reason: "unclosed" | "missing-key" | "bad-field";
  /** 1-based line where the entry that failed starts. */
  line: number;
  /** The citation key, when the parser got that far. */
  key?: string;
};

/** Why the visual form cannot show a file that failed with `error`. */
export function bibUnreadableReason(error: BibParseError): string {
  const { line, key } = error;
  if (error.reason === "missing-key") return i18n._(msg`Line ${line}: an entry has no citation key.`);
  if (error.reason === "unclosed") {
    return key ? i18n._(msg`Line ${line}: the entry “${key}” is never closed.`) : i18n._(msg`Line ${line}: an entry is never closed.`);
  }
  return key ? i18n._(msg`Line ${line}: a field of “${key}” could not be read.`) : i18n._(msg`Line ${line}: a field could not be read.`);
}

export type BibParse = { document: BibDocument; error: null } | { document: null; error: BibParseError };

/** A splice into the .bib text. */
export type BibEdit = { from: number; to: number; insert: string };

const isSpace = (character: string | undefined) => character === " " || character === "\t" || character === "\n" || character === "\r";
const NAME = /[^\s"#%'(),={}]/;

/** Line starts, for turning offsets into 1-based line numbers by binary search. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** Index of the brace closing the group opened at `open`, or -1. */
function closeBrace(source: string, open: number, limit = source.length): number {
  let depth = 0;
  for (let index = open; index < limit; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

/** One past the end of the value part starting at `start` (a group, a string, a number or a macro name), or -1. */
function valuePartEnd(source: string, start: number, close: string): number {
  const first = source[start];
  if (first === "{") {
    const end = closeBrace(source, start);
    return end === -1 ? -1 : end + 1;
  }
  if (first === '"') {
    let depth = 0;
    for (let index = start + 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === '"' && depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
    return -1;
  }
  let index = start;
  while (index < source.length && NAME.test(source[index]) && source[index] !== close) index += 1;
  return index === start ? -1 : index;
}

/** Skip whitespace and `%` line comments between an entry's tokens. */
function skipGap(source: string, index: number): number {
  for (;;) {
    while (isSpace(source[index])) index += 1;
    if (source[index] !== "%") return index;
    while (index < source.length && source[index] !== "\n") index += 1;
  }
}

/** The end (one past the last part) of the `#`-joined value starting at `start`, or -1. */
function valueEnd(source: string, start: number, close: string): number {
  let end = valuePartEnd(source, start, close);
  while (end !== -1) {
    const next = skipGap(source, end);
    if (source[next] !== "#") return end;
    end = valuePartEnd(source, skipGap(source, next + 1), close);
  }
  return -1;
}

/** The end of a delimited `@comment` / `@preamble` / `@string` body opened at `open`, or -1. */
function directiveEnd(source: string, open: number): number {
  if (source[open] === "{") return closeBrace(source, open);
  let depth = 0;
  for (let index = open + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ")" && depth === 0) return index;
  }
  return -1;
}

/** Parse the whole file. A malformed entry fails the parse: the editor only edits what it can read whole. */
export function parseBibDocument(source: string): BibParse {
  const starts = lineStarts(source);
  const entries: BibEntry[] = [];
  const macros = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    // Outside entries BibTeX ignores everything; a `%` line can hide an `@`.
    if (character === "%") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character !== "@") {
      index += 1;
      continue;
    }
    const from = index;
    const typeFrom = skipGap(source, from + 1);
    let typeTo = typeFrom;
    while (typeTo < source.length && /[A-Za-z0-9_-]/.test(source[typeTo])) typeTo += 1;
    const open = skipGap(source, typeTo);
    if (typeTo === typeFrom || (source[open] !== "{" && source[open] !== "(")) {
      index = from + 1;
      continue;
    }
    const type = source.slice(typeFrom, typeTo);
    const kind = type.toLowerCase();
    const line = lineAt(starts, from);
    const close = source[open] === "{" ? "}" : ")";
    if (kind === "comment" || kind === "preamble" || kind === "string") {
      const end = directiveEnd(source, open);
      if (end === -1) return { document: null, error: { reason: "unclosed", line } };
      if (kind === "string") {
        const nameFrom = skipGap(source, open + 1);
        let nameTo = nameFrom;
        while (nameTo < end && NAME.test(source[nameTo])) nameTo += 1;
        const equals = skipGap(source, nameTo);
        if (nameTo > nameFrom && source[equals] === "=") {
          const valueFrom = skipGap(source, equals + 1);
          const valueTo = valueEnd(source, valueFrom, close);
          if (valueTo !== -1 && valueTo <= end) macros.set(source.slice(nameFrom, nameTo).toLowerCase(), source.slice(valueFrom, valueTo));
        }
      }
      index = end + 1;
      continue;
    }
    const keyFrom = skipGap(source, open + 1);
    let keyTo = keyFrom;
    while (keyTo < source.length && !isSpace(source[keyTo]) && !",{}()".includes(source[keyTo])) keyTo += 1;
    // `@misc{,` and `@misc{ title = …` have no key.
    if (keyTo === keyFrom || source[keyTo] === "=" || source.slice(keyFrom, keyTo).includes("=")) {
      return { document: null, error: { reason: "missing-key", line } };
    }
    const key = source.slice(keyFrom, keyTo);
    const fields: BibField[] = [];
    let cursor = skipGap(source, keyTo);
    let trailingComma = false;
    let failed: BibParseError["reason"] | null = null;
    while (failed === null) {
      if (source[cursor] === close) break;
      if (source[cursor] !== ",") {
        failed = cursor >= source.length ? "unclosed" : "bad-field";
        break;
      }
      cursor = skipGap(source, cursor + 1);
      trailingComma = true;
      if (source[cursor] === close) break;
      const nameFrom = cursor;
      while (cursor < source.length && NAME.test(source[cursor])) cursor += 1;
      const equals = skipGap(source, cursor);
      if (cursor === nameFrom || source[equals] !== "=") {
        // The next entry's `@` where a field should be: this one was never closed.
        failed = cursor >= source.length || source[nameFrom] === "@" ? "unclosed" : "bad-field";
        break;
      }
      const valueFrom = skipGap(source, equals + 1);
      const valueTo = valueEnd(source, valueFrom, close);
      if (valueTo === -1) {
        failed = valueFrom >= source.length || source[valueFrom] === "{" || source[valueFrom] === '"' ? "unclosed" : "bad-field";
        break;
      }
      fields.push({ name: source.slice(nameFrom, cursor), from: nameFrom, valueFrom, valueTo });
      trailingComma = false;
      cursor = skipGap(source, valueTo);
    }
    if (failed !== null) {
      // An unclosed field value usually swallows the rest of the file, so name the entry it started in.
      return { document: null, error: { reason: failed, line, key } };
    }
    entries.push({ type, kind, key, from, to: cursor + 1, typeFrom, keyFrom, keyTo, fields, trailingComma, line });
    index = cursor + 1;
  }
  return { document: { entries, macros }, error: null };
}

// ---- Reading values ----------------------------------------------------------------------------------------------

/** BibTeX's predefined macros, which a bare value may name without an `@string`. */
const MONTH_MACROS = new Set(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]);

/** The `#`-joined parts of a raw value, each as written. */
function valueParts(raw: string): string[] {
  const parts: string[] = [];
  let index = skipGap(raw, 0);
  while (index < raw.length) {
    const end = valuePartEnd(raw, index, "");
    if (end === -1) return [raw];
    parts.push(raw.slice(index, end));
    index = skipGap(raw, end);
    if (raw[index] !== "#") break;
    index = skipGap(raw, index + 1);
  }
  return parts;
}

/** A raw value with its delimiters gone and macros expanded, still LaTeX. */
export function expandBibValue(raw: string, macros: Map<string, string>, depth = 0): string {
  return valueParts(raw).map((part) => {
    if (part.startsWith("{") || part.startsWith('"')) return part.slice(1, -1);
    if (/^\d+$/.test(part)) return part;
    const macro = macros.get(part.toLowerCase());
    if (macro !== undefined && depth < 8) return expandBibValue(macro, macros, depth + 1);
    return part;
  }).join("");
}

// Accent commands and the combining marks they put on the following letter.
const ACCENTS: Record<string, string> = {
  '"': "̈", "'": "́", "`": "̀", "^": "̂", "~": "̃", "=": "̄", ".": "̇",
  u: "̆", v: "̌", H: "̋", c: "̧", k: "̨", r: "̊", d: "̣", b: "̱",
};
const LETTERS: Record<string, string> = {
  aa: "å", AA: "Å", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø", ss: "ß", l: "ł", L: "Ł", i: "ı", j: "ȷ",
  textendash: "–", textemdash: "—", ldots: "…", dots: "…", textregistered: "®", copyright: "©", S: "§", P: "¶",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", chi: "χ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  ell: "ℓ", infty: "∞", times: "×", pm: "±", leq: "≤", geq: "≥", le: "≤", ge: "≥", to: "→", rightarrow: "→", cdot: "·",
};

/** BibTeX's LaTeX as the reader sees it: accents composed, groups and markup commands dropped, dashes and quotes typeset. */
export function bibTextToPlain(value: string): string {
  return value
    // \"{o}, \"o, {\"o}, \c c, \v{s}
    .replace(/\\(["'`^~=.])\s*(?:\{\s*(\\?[A-Za-z])\s*\}|(\\?[A-Za-z]))/g, (_, accent: string, braced?: string, bare?: string) => (
      `${(braced ?? bare ?? "").replace(/^\\/, "")}${ACCENTS[accent]}`.normalize()
    ))
    .replace(/\\([uvHckrdb])(?:\s*\{\s*(\\?[A-Za-z])\s*\}|\s+(\\?[A-Za-z]))/g, (_, accent: string, braced?: string, bare?: string) => (
      `${(braced ?? bare ?? "").replace(/^\\/, "")}${ACCENTS[accent]}`.normalize()
    ))
    .replace(/\\([A-Za-z]+)(?![A-Za-z])\s*(\{\s*\})?/g, (match, name: string) => LETTERS[name] ?? match)
    .replace(/\\([&%$#_{}])/g, "$1")
    // \emph{x}, \textbf{x}, \url{x}: keep the argument.
    .replace(/\\[A-Za-z]+\*?\s*(?=\{)/g, "")
    .replace(/\\[A-Za-z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\$/g, "")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/``/g, "“")
    .replace(/''/g, "”")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The entry's fields by lower-cased name, expanded but still LaTeX. */
export function entryValues(source: string, entry: BibEntry, macros: Map<string, string>): Map<string, string> {
  const values = new Map<string, string>();
  for (const field of entry.fields) {
    const name = field.name.toLowerCase();
    if (!values.has(name)) values.set(name, expandBibValue(source.slice(field.valueFrom, field.valueTo), macros));
  }
  return values;
}

/** What the list shows of an entry, and what search reads. */
export type BibSummary = {
  title: string;
  authors: string;
  /** "Vaswani et al." */
  shortAuthors: string;
  year: string;
  venue: string;
  doi: string;
  arxivId: string;
  url: string;
  /** Lower-cased key, title, authors (as written too), venue, year and type, for the filter. */
  haystack: string;
};

export function summarizeEntry(source: string, entry: BibEntry, macros: Map<string, string>): BibSummary {
  const values = entryValues(source, entry, macros);
  const plain = (name: string) => bibTextToPlain(values.get(name) ?? "");
  // Identifiers keep their dashes and underscores: only grouping and escapes go.
  const literal = (name: string) => (values.get(name) ?? "").replace(/\\([_%&#])/g, "$1").replace(/[{}]/g, "").trim();
  const rawAuthors = values.get("author") ?? values.get("editor") ?? "";
  // "Ashish Vaswani, Noam Shazeer": people as they are read, not as BibTeX sorts them.
  const authors = paperAuthorNames({ authors: rawAuthors }).map(bibTextToPlain).join(", ");
  const shortAuthors = bibTextToPlain(paperShortAuthors({ authors: rawAuthors }) ?? "");
  const year = plain("year") || (values.get("date") ?? "").slice(0, 4);
  const doi = literal("doi").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  const eprint = literal("eprint");
  const archive = `${literal("archiveprefix")} ${literal("eprinttype")}`.toLowerCase();
  const url = literal("url");
  const arxivId = (archive.includes("arxiv") || /^\d{4}\.\d{4,5}/.test(eprint) ? explicitArxivId(eprint) : undefined)
    ?? (url ? explicitArxivId(url) : undefined)
    ?? /arxiv[:\s]+(\d{4}\.\d{4,5})/i.exec(`${plain("journal")} ${plain("note")}`)?.[1]
    ?? "";
  const venue = ["journal", "journaltitle", "booktitle", "publisher", "school", "institution", "organization", "howpublished"]
    .map(plain).find(Boolean) ?? (arxivId ? "arXiv" : "");
  const title = plain("title");
  return {
    title, authors, shortAuthors, year, venue, doi, arxivId, url,
    haystack: `${entry.key}\n${title}\n${authors}\n${bibTextToPlain(rawAuthors)}\n${venue}\n${year}\n${entry.kind}\n${doi}\n${arxivId}`.toLowerCase(),
  };
}

let summaries: { macros: string; byText: Map<string, BibSummary> } = { macros: "", byText: new Map() };

/**
 * Every entry's summary. Reading titles, author lists and venues is most of a
 * large file's cost, so an entry whose text (and the file's macros) is as it
 * was at the last call keeps the summary it had then.
 */
export function summarizeEntries(source: string, document: BibDocument): BibSummary[] {
  const macros = [...document.macros].join("\n");
  const previous = summaries.macros === macros ? summaries.byText : new Map<string, BibSummary>();
  const byText = new Map<string, BibSummary>();
  const result = document.entries.map((entry) => {
    const text = source.slice(entry.from, entry.to);
    const summary = previous.get(text) ?? byText.get(text) ?? summarizeEntry(source, entry, document.macros);
    byText.set(text, summary);
    return summary;
  });
  summaries = { macros, byText };
  return result;
}

// ---- Editing values ----------------------------------------------------------------------------------------------

/** How a field's value is written, so an edit keeps the writer's delimiters. */
export type BibValueStyle = "brace" | "quote" | "bare" | "raw";

/** A field value as the form edits it: the text between its delimiters, or the whole expression for a concatenation. */
export function editableValue(raw: string): { text: string; style: BibValueStyle } {
  const parts = valueParts(raw);
  if (parts.length !== 1 || parts[0] !== raw.trim()) return { text: raw, style: "raw" };
  const [part] = parts;
  if (part.startsWith("{")) return { text: part.slice(1, -1), style: "brace" };
  if (part.startsWith('"')) return { text: part.slice(1, -1), style: "quote" };
  return { text: part, style: "bare" };
}

/** Braces nest and close in order, as BibTeX needs them to. */
export function balancedBraces(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === "{") depth += 1;
    else if (character === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The raw value for `text` in `style`, or null when no delimiters can hold it
 * (unbalanced braces, or a raw expression that does not parse).
 */
export function encodeValue(text: string, style: BibValueStyle, macros: Map<string, string>): string | null {
  if (style === "raw") {
    const value = text.trim();
    return value && valueEnd(value, 0, "") === value.length ? value : null;
  }
  if (!balancedBraces(text)) return null;
  if (style === "bare" && (/^\d+$/.test(text) || macros.has(text.toLowerCase()) || MONTH_MACROS.has(text.toLowerCase()))) return text;
  if (style === "quote" && !hasTopLevelQuote(text)) return `"${text}"`;
  return `{${text}}`;
}

function hasTopLevelQuote(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === '"' && depth === 0) return true;
  }
  return false;
}

/** A citation key BibTeX and `\cite` both accept. */
export function validCitationKey(key: string): boolean {
  return /^[^\s"#%'(),={}\\~]+$/.test(key);
}

/** Where the entry's fields are indented, and how `name = value` is spaced, taken from its first field. */
function fieldLayout(source: string, entry: BibEntry) {
  const first = entry.fields[0];
  if (!first) return { indent: "  ", equals: " = ", newline: source.includes("\r\n") ? "\r\n" : "\n" };
  const lineStart = source.lastIndexOf("\n", first.from - 1) + 1;
  const before = source.slice(lineStart, first.from);
  const nameEnd = first.from + first.name.length;
  return {
    indent: /^[\t ]*$/.test(before) ? before : "  ",
    equals: source.slice(nameEnd, first.valueFrom) || " = ",
    newline: source.includes("\r\n") ? "\r\n" : "\n",
  };
}

export function replaceValueEdit(field: BibField, raw: string): BibEdit {
  return { from: field.valueFrom, to: field.valueTo, insert: raw };
}

export function renameKeyEdit(entry: BibEntry, key: string): BibEdit {
  return { from: entry.keyFrom, to: entry.keyTo, insert: key };
}

export function changeTypeEdit(entry: BibEntry, type: string): BibEdit {
  return { from: entry.typeFrom, to: entry.typeFrom + entry.type.length, insert: type };
}

/** Add `name = raw` after the entry's last field, laid out like its other fields. */
export function addFieldEdit(source: string, entry: BibEntry, name: string, raw: string): BibEdit {
  const { indent, equals, newline } = fieldLayout(source, entry);
  const last = entry.fields.at(-1);
  const field = `${indent}${name}${equals}${raw}`;
  if (!last) {
    // After the key: `@misc{key}` or `@misc{key,` become one field long.
    const at = entry.keyTo;
    const rest = source.slice(at, entry.to - 1);
    return { from: at, to: entry.to - 1, insert: `,${newline}${field}${rest.includes(",") ? "," : ""}${newline}` };
  }
  if (entry.trailingComma) {
    const comma = source.indexOf(",", last.valueTo);
    return { from: comma + 1, to: comma + 1, insert: `${newline}${field},` };
  }
  return { from: last.valueTo, to: last.valueTo, insert: `,${newline}${field}` };
}

/** Remove a field with its separating comma and, when it stands on its own line, that line. */
export function removeFieldEdit(source: string, entry: BibEntry, field: BibField): BibEdit {
  const index = entry.fields.indexOf(field);
  const next = entry.fields[index + 1];
  const previous = entry.fields[index - 1];
  const lineStart = source.lastIndexOf("\n", field.from - 1) + 1;
  const ownLine = /^[\t ]*$/.test(source.slice(lineStart, field.from));
  if (next) {
    // Up to the next field, so its own indentation (now this one's) stays.
    const nextLineStart = source.lastIndexOf("\n", next.from - 1) + 1;
    const nextOwnLine = /^[\t ]*$/.test(source.slice(nextLineStart, next.from));
    return ownLine && nextOwnLine ? { from: lineStart, to: nextLineStart, insert: "" } : { from: field.from, to: next.from, insert: "" };
  }
  // The last field: take the comma before it (unless the entry keeps a trailing one) and its line.
  const after = source.indexOf(",", field.valueTo);
  const end = entry.trailingComma && after !== -1 && after < entry.to ? after + 1 : field.valueTo;
  if (entry.trailingComma) {
    const lineEnd = /^[\t ]*\r?\n/.exec(source.slice(end))?.[0].length ?? 0;
    return { from: ownLine ? lineStart : field.from, to: ownLine ? end + lineEnd : end, insert: "" };
  }
  const start = previous ? previous.valueTo : entry.keyTo;
  return { from: start, to: end, insert: "" };
}

/**
 * Remove the entry. Standing on lines of its own, it goes with them and the
 * blank lines after it, so its neighbours keep the spacing between them; the
 * file's last entry takes the blank lines before it instead.
 */
export function deleteEntryEdit(source: string, entry: BibEntry): BibEdit {
  const lineStart = source.lastIndexOf("\n", entry.from - 1) + 1;
  const rest = /^[\t ]*(?:\r?\n|$)/.exec(source.slice(entry.to));
  if (!rest || source.slice(lineStart, entry.from).trim() !== "") return { from: entry.from, to: entry.to, insert: "" };
  const to = entry.to + rest[0].length;
  const blanks = /^(?:[\t ]*\r?\n)*/.exec(source.slice(to))![0];
  if (source.slice(to).trim() !== "") return { from: lineStart, to: to + blanks.length, insert: "" };
  const before = /(?:\r?\n[\t ]*)+$/.exec(source.slice(0, lineStart));
  // Keep the line break that ends the entry before it.
  const from = before ? lineStart - before[0].length + (before[0].startsWith("\r") ? 2 : 1) : lineStart;
  return { from, to, insert: "" };
}

export function applyBibEdit(source: string, edit: BibEdit): string {
  return `${source.slice(0, edit.from)}${edit.insert}${source.slice(edit.to)}`;
}

let lastRead: { source: string; parse: BibParse } | null = null;

/**
 * `parseBibDocument`, remembering the last text read: the canvas (deciding
 * whether the list can show) and the list itself read the same text.
 */
export function readBibDocument(source: string): BibParse {
  if (lastRead?.source !== source) lastRead = { source, parse: parseBibDocument(source) };
  return lastRead.parse;
}
