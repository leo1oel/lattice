const SPECIAL_ENTRY_TYPES = new Set(["string", "preamble", "comment"]);

type EntryBounds = { end: number; open: "{" | "("; close: "}" | ")" };

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

/**
 * Formats only complete, conventional BibTeX entries. Anything the scanner
 * cannot classify without interpreting BibTeX is copied byte-for-byte.
 */
export function formatBibDocument(source: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const entryStart = /(^|\n)([\t ]*)@([A-Za-z][A-Za-z0-9_-]*)[\t ]*([({])/g;
  let output = "";
  let copiedThrough = 0;
  let match: RegExpExecArray | null;

  while ((match = entryStart.exec(source)) !== null) {
    const at = match.index + match[1].length + match[2].length;
    const openIndex = entryStart.lastIndex - 1;
    const bounds = findEntryEnd(source, openIndex);
    if (!bounds) break;
    const formatted = formatEntry(match[3], source.slice(openIndex + 1, bounds.end), bounds.open, newline);
    if (formatted) {
      output += source.slice(copiedThrough, at) + formatted;
      copiedThrough = bounds.end + 1;
    }
    entryStart.lastIndex = bounds.end + 1;
  }
  return output + source.slice(copiedThrough);
}
