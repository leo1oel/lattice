import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";

const SPECIAL_ENTRY_TYPES = new Set(["string", "preamble", "comment"]);

type EntryBounds = { end: number; open: "{" | "("; close: "}" | ")" };
type FormattedEntry = { start: number; end: number; formatted: string };

function findEntryEnd(source: string, openIndex: number): EntryBounds | null {
  const open = source[openIndex] as "{" | "(";
  const close = open === "{" ? "}" : ")";
  let delimiterDepth = 1;
  let braceDepth = 0;
  let quoted = false;
  let escaped = false;
  let comment = false;

  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (comment) {
      if (character === "\n" || character === "\r") comment = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (!quoted && character === "%") {
      comment = true;
      continue;
    }
    if (character === '"' && braceDepth === 0) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") braceDepth += 1;
    else if (character === "}" && braceDepth > 0) braceDepth -= 1;
    else if (braceDepth === 0 && character === open) delimiterDepth += 1;
    else if (braceDepth === 0 && character === close) {
      delimiterDepth -= 1;
      if (delimiterDepth === 0) return { end: index, open, close };
    }
  }
  return null;
}

/** Read real entry keys, skipping directives and at-signs inside field values. */
export function bibEntryKeys(source: string): string[] {
  const headers = /@([A-Za-z][A-Za-z0-9_-]*)\s*([({])/g;
  const keys: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headers.exec(source)) !== null) {
    const line = source.slice(source.lastIndexOf("\n", match.index) + 1, match.index);
    if (/(^|[^\\])%/.test(line)) continue;
    const openIndex = headers.lastIndex - 1;
    const bounds = findEntryEnd(source, openIndex);
    if (!bounds) throw new Error(i18n._(msg`Complete the unfinished bibliography entry before adding another reference.`));
    headers.lastIndex = bounds.end + 1;
    if (SPECIAL_ENTRY_TYPES.has(match[1].toLowerCase())) continue;
    const key = /^\s*([^\s,{}()]+)\s*,/.exec(source.slice(openIndex + 1, bounds.end))?.[1];
    if (!key) throw new Error(i18n._(msg`An existing bibliography entry has an invalid citation key.`));
    keys.push(key);
  }
  return keys;
}

function topLevelCommas(body: string, outer: "{" | "("): number[] | null {
  const commas: number[] = [];
  let braces = 0;
  let parentheses = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    // Comments between fields are legal but retaining their attachment while moving
    // whitespace is ambiguous, so the whole entry is deliberately left alone.
    if (!quoted && character === "%") return null;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' && braces === 0) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (outer === "(" && character === "(" && braces === 0) parentheses += 1;
    else if (outer === "(" && character === ")" && braces === 0) parentheses -= 1;
    else if (character === "," && braces === 0 && parentheses === 0) commas.push(index);
    if (braces < 0 || parentheses < 0) return null;
  }
  return quoted || braces !== 0 || parentheses !== 0 ? null : commas;
}

function formatEntry(type: string, body: string, open: "{" | "(", newline: string): string | null {
  if (SPECIAL_ENTRY_TYPES.has(type.toLowerCase())) return null;
  const commas = topLevelCommas(body, open);
  if (!commas?.length) return null;

  const key = body.slice(0, commas[0]).trim();
  if (!key || /\s/.test(key)) return null;
  const trailingComma = body.slice(commas.at(-1)! + 1).trim() === "";
  const fieldEnds = trailingComma ? commas : [...commas, body.length];
  const fields: string[] = [];
  for (let index = 0; index < fieldEnds.length - 1; index += 1) {
    const start = commas[index] + 1;
    const field = body.slice(start, fieldEnds[index + 1]).trim();
    const match = /^([A-Za-z][A-Za-z0-9_:.+-]*)\s*=\s*([\s\S]*\S)$/.exec(field);
    if (!match) return null;
    fields.push(`${match[1]} = ${match[2]}`);
  }
  if (!fields.length) return null;

  const close = open === "{" ? "}" : ")";
  const renderedFields = fields.map((field) => `  ${field}`).join(`,${newline}`);
  return `@${type}${open}${key},${newline}${renderedFields}${trailingComma ? "," : ""}${newline}${close}`;
}

function formattedEntryAt(source: string, start: number, newline: string): FormattedEntry | null {
  const header = /^@([A-Za-z][A-Za-z0-9_-]*)[\t ]*([({])/.exec(source.slice(start));
  if (!header) return null;
  const openIndex = start + header[0].length - 1;
  const bounds = findEntryEnd(source, openIndex);
  if (!bounds) return null;
  const formatted = formatEntry(header[1], source.slice(openIndex + 1, bounds.end), bounds.open, newline);
  return formatted ? { start, end: bounds.end, formatted } : null;
}

/**
 * Formats only complete, conventional BibTeX entries. Anything the scanner
 * cannot classify without interpreting BibTeX is copied byte-for-byte.
 */
export function formatBibDocument(source: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const entryStart = /(^|\n)([\t ]*)@([A-Za-z][A-Za-z0-9_-]*)[\t ]*([({])/g;
  const entries: FormattedEntry[] = [];
  let match: RegExpExecArray | null;

  while ((match = entryStart.exec(source)) !== null) {
    const at = match.index + match[1].length + match[2].length;
    const openIndex = entryStart.lastIndex - 1;
    const bounds = findEntryEnd(source, openIndex);
    if (!bounds) break;
    const formatted = formatEntry(match[3], source.slice(openIndex + 1, bounds.end), bounds.open, newline);
    if (formatted) {
      entries.push({ start: at, end: bounds.end, formatted });

      // Once an entry establishes a BibTeX boundary, another entry may follow
      // without a line break. Only cross whitespace here: a general search for
      // "@" would mistake values and arbitrary prose for entry boundaries.
      let previousEnd = bounds.end;
      while (previousEnd + 1 < source.length) {
        const gap = /^[\t \r\n]*/.exec(source.slice(previousEnd + 1))![0];
        const adjacent = formattedEntryAt(source, previousEnd + 1 + gap.length, newline);
        if (!adjacent) break;
        entries.push(adjacent);
        previousEnd = adjacent.end;
      }
      entryStart.lastIndex = previousEnd + 1;
    } else {
      entryStart.lastIndex = bounds.end + 1;
    }
  }

  let output = "";
  let copiedThrough = 0;
  for (const [index, entry] of entries.entries()) {
    const gap = source.slice(copiedThrough, entry.start);
    const normalizedGap = index > 0 && /^[\t \r\n]*$/.test(gap) ? `${newline}${newline}` : gap;
    output += normalizedGap + entry.formatted;
    copiedThrough = entry.end + 1;
  }
  return output + source.slice(copiedThrough);
}
