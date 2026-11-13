/**
 * A `tabular` (and `tabular*`, `tabularx`, `tabulary`, `longtable`, `array`)
 * read into rows and cells for Visual mode to draw as a table: the column
 * alignments and rules its preamble gives, booktabs' and `\hline`'s rules,
 * `\multicolumn` and `\multirow` spans. Cells stay LaTeX, which the inline
 * renderer sets. Only read: the source is never rewritten from this.
 */
import { groupEnd } from "./visual-inline";
import { TABLE_ENVIRONMENTS } from "./visual-symbols";

export { TABLE_ENVIRONMENTS };

export type ColumnAlign = "left" | "center" | "right";
/** A rule across a row's edge: booktabs' heavy top and bottom rules, or a light one. */
export type Rule = "heavy" | "light" | null;

export type TableCell = {
  /** The cell's LaTeX. */
  text: string;
  align: ColumnAlign;
  colspan: number;
  rowspan: number;
  /** Whether a vertical rule is drawn at its left or right edge. */
  left: boolean;
  right: boolean;
  /** Where its text starts in the document. */
  from: number;
};

export type TableRow = {
  cells: TableCell[];
  /** The rule over the row, and the partial ones (`\cmidrule{2-3}`) under it, by column. */
  above: Rule;
  below: Rule;
  partialBelow: number[];
};

export type Table = {
  columns: { align: ColumnAlign; wraps: boolean; left: boolean; right: boolean }[];
  rows: TableRow[];
  /** `tabular*`/`tabularx` set to a width: drawn across the column. */
  fullWidth: boolean;
};

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX names */
/** Rules between rows, as each draws. */
const RULES: ReadonlyMap<string, Rule> = new Map([
  ["toprule", "heavy"], ["bottomrule", "heavy"], ["midrule", "light"], ["hline", "light"], ["specialrule", "heavy"],
  ["Xhline", "heavy"], ["hhline", "light"], ["thickhline", "heavy"],
]);
/** Commands between rows that draw nothing here. */
const ROW_NOISE = new Set(["addlinespace", "noalign", "rowcolor", "rowcolors", "endhead", "endfirsthead", "endfoot", "endlastfoot", "morecmidrules", "arrayrulecolor", "centering", "small", "footnotesize", "scriptsize"]);
/* eslint-enable lingui/no-unlocalized-strings */

/** The most rows and columns read: a table longer than this is drawn up to it. */
const ROW_LIMIT = 400;
const COLUMN_LIMIT = 60;

/** Columns from a tabular preamble (`l|cc|p{3cm}`, `*{3}{c}`, `@{}lX@{}`). */
export function parseColumns(spec: string): Table["columns"] {
  const columns: Table["columns"] = [];
  let bar = false;
  const expand = (text: string, depth: number) => {
    for (let at = 0; at < text.length && columns.length < COLUMN_LIMIT;) {
      const char = text[at];
      if (char === "|") {
        if (columns.length && !bar) columns[columns.length - 1].right = true;
        bar = true;
        at++;
        continue;
      }
      if (char === "*" && depth < 4) {
        const countEnd = groupEnd(text, at + 1);
        const bodyEnd = countEnd == null ? null : groupEnd(text, countEnd);
        if (countEnd == null || bodyEnd == null) return;
        const count = Math.min(Number(text.slice(at + 2, countEnd - 1)) || 0, COLUMN_LIMIT);
        const body = text.slice(countEnd + 1, bodyEnd - 1);
        for (let index = 0; index < count; index++) expand(body, depth + 1);
        at = bodyEnd;
        continue;
      }
      if (char === "@" || char === "!" || char === ">" || char === "<") {
        at = groupEnd(text, at + 1) ?? text.length;
        continue;
      }
      const align: ColumnAlign | null = char === "l" || char === "L" ? "left" : char === "r" || char === "R" ? "right"
        : char === "c" || char === "C" || char === "S" || char === "D" ? "center"
          : char === "p" || char === "m" || char === "b" || char === "X" || char === "Y" || char === "J" ? "left" : null;
      at++;
      if (align === null) continue;
      const wraps = "pmbXYJ".includes(char);
      if ("pmb".includes(char)) at = groupEnd(text, at) ?? at;
      if (char === "D") for (let index = 0; index < 3; index++) at = groupEnd(text, at) ?? at;
      columns.push({ align: char === "Y" ? "center" : align, wraps, left: bar && columns.length === 0, right: false });
      bar = false;
    }
  };
  expand(spec.replace(/\s+/g, ""), 0);
  return columns;
}

/** Where the arguments of `\begin{name}` end, and its column preamble. */
function preamble(text: string, at: number, name: string): { spec: string; end: number; fullWidth: boolean } | null {
  const skip = (from: number) => {
    let index = from;
    while (/\s/.test(text[index] ?? "")) index++;
    return index;
  };
  let index = skip(at);
  const widthed = name === "tabular*" || name === "tabularx" || name === "tabulary" || name === "xtabular*";
  if (widthed) {
    const end = groupEnd(text, index);
    if (end == null) return null;
    index = skip(end);
  }
  if (text[index] === "[") index = skip(groupEnd(text, index, "[", "]") ?? index);
  const end = groupEnd(text, index);
  if (end == null) return null;
  return { spec: text.slice(index + 1, end - 1), end, fullWidth: widthed };
}

/**
 * The table `text` holds, its `\begin{…}` at the start: `offset` is where
 * `text` starts in the document. Null when its preamble cannot be read.
 */
export function parseTable(text: string, offset: number): Table | null {
  const begin = /^\\begin\s*\{([^{}]+)\}/.exec(text);
  if (!begin) return null;
  const name = begin[1].trim();
  const head = preamble(text, begin[0].length, name);
  if (!head) return null;
  const close = text.lastIndexOf(`\\end{${name}}`);
  const bodyEnd = close > head.end ? close : text.length;
  const columns = parseColumns(head.spec);
  const rows = parseRows(text.slice(head.end, bodyEnd), offset + head.end, columns);
  return { columns, rows, fullWidth: head.fullWidth };
}

/** The body's rows, split at `\\` and `&` outside groups, with the rules between them. */
function parseRows(body: string, offset: number, columns: Table["columns"]): TableRow[] {
  const rows: TableRow[] = [];
  let pending: Rule = null;
  /** Rows still covered by a `\multirow` above, by column. */
  const covered: number[] = [];
  for (const raw of splitTop(body, "\\\\", offset)) {
    if (rows.length >= ROW_LIMIT) break;
    let { text, from } = raw;
    // Rules and spacing before the row's first cell.
    const partial: number[] = [];
    for (;;) {
      const lead = /^(?:\s|%[^\n]*\n?)*/.exec(text)![0].length;
      text = text.slice(lead);
      from += lead;
      if (text.startsWith("[")) {
        // `\\[4pt]`: the extra space after the row before.
        const end = groupEnd(text, 0, "[", "]");
        if (end == null) break;
        text = text.slice(end);
        from += end;
        continue;
      }
      const command = /^\\([A-Za-z]+)\*?/.exec(text);
      if (!command) break;
      const ruleName = command[1];
      const rule = RULES.get(ruleName);
      const partialRule = ruleName === "cline" || ruleName === "cmidrule" || ruleName === "cdashline";
      if (rule === undefined && !partialRule && !ROW_NOISE.has(ruleName)) break;
      let at = command[0].length;
      // Each rule's own arguments: `\cmidrule[w](lr){2-3}`, `\specialrule{w}{a}{b}`, `\rowcolor{gray}`.
      for (let guard = 0; guard < 4; guard++) {
        while (/\s/.test(text[at] ?? "")) at++;
        const open = text[at];
        const end = open === "[" ? groupEnd(text, at, "[", "]") : open === "(" ? groupEnd(text, at, "(", ")") : open === "{" ? groupEnd(text, at) : null;
        if (end == null) break;
        if (open === "{" && partialRule) {
          const range = /^(\d+)\s*-\s*(\d+)$/.exec(text.slice(at + 1, end - 1).trim());
          if (range) for (let column = Number(range[1]); column <= Number(range[2]) && column <= COLUMN_LIMIT; column++) partial.push(column - 1);
        }
        at = end;
        if (open === "{" && !(ruleName === "specialrule" && guard < 2) && ruleName !== "hhline") break;
      }
      text = text.slice(at);
      from += at;
      if (rule !== undefined && rule !== null) {
        // A rule after the last row closes it; one before a row opens it.
        pending = pending === "heavy" ? pending : rule;
      }
      if (partial.length && rows.length) rows[rows.length - 1].partialBelow.push(...partial.splice(0));
    }
    if (!text.trim()) {
      if (pending && rows.length) rows[rows.length - 1].below = pending;
      if (partial.length && rows.length) rows[rows.length - 1].partialBelow.push(...partial);
      pending = rows.length ? null : pending;
      continue;
    }
    const cells: TableCell[] = [];
    let column = 0;
    for (const part of splitTop(text, "&", from)) {
      if ((covered[column] ?? 0) > 0) {
        covered[column]--;
        // The empty cell a `\multirow` above spans: its column is taken, nothing to draw.
        if (!part.text.trim()) {
          column++;
          continue;
        }
      }
      const cell = readCell(part.text, part.from, columns[column]);
      if (!cell) continue;
      for (let index = 0; index < cell.colspan; index++) {
        if (cell.rowspan > 1) covered[column + index] = cell.rowspan - 1;
      }
      cells.push(cell);
      column += cell.colspan;
    }
    rows.push({ cells, above: pending, below: null, partialBelow: [] });
    pending = null;
  }
  if (pending && rows.length) rows[rows.length - 1].below = pending;
  return rows;
}

/** A cell's text, unwrapped from `\multicolumn{n}{spec}{…}` and `\multirow{n}{w}{…}`. */
function readCell(raw: string, from: number, column: Table["columns"][number] | undefined): TableCell | null {
  const lead = raw.length - raw.trimStart().length;
  let text = raw.trim();
  let start = from + lead;
  let colspan = 1;
  let rowspan = 1;
  let align: ColumnAlign = column?.align ?? "left";
  let left = column?.left ?? false;
  let right = column?.right ?? false;
  for (let guard = 0; guard < 3; guard++) {
    const multi = /^\\(multicolumn|multirow|makecell|shortstack)\b\*?/.exec(text);
    if (!multi) break;
    let at = multi[0].length;
    const args: string[] = [];
    const wanted = multi[1] === "multicolumn" ? 3 : multi[1] === "multirow" ? 3 : 1;
    while (args.length < wanted) {
      while (/\s/.test(text[at] ?? "")) at++;
      if (text[at] === "[") {
        at = groupEnd(text, at, "[", "]") ?? text.length;
        continue;
      }
      const end = groupEnd(text, at);
      if (end == null) break;
      args.push(text.slice(at + 1, end - 1));
      if (args.length === wanted) {
        start += at + 1;
        text = text.slice(at + 1, end - 1);
        break;
      }
      at = end;
    }
    if (args.length < wanted) break;
    if (multi[1] === "multicolumn") {
      colspan = Math.max(1, Math.min(COLUMN_LIMIT, Number(args[0]) || 1));
      const spec = parseColumns(args[1]);
      if (spec[0]) ({ align, left, right } = spec[0]);
      if (/^\s*\|/.test(args[1])) left = true;
      if (/\|\s*$/.test(args[1])) right = true;
    } else if (multi[1] === "multirow") {
      rowspan = Math.max(1, Math.min(ROW_LIMIT, Math.abs(Number(args[0])) || 1));
    }
    const inner = text.length - text.trimStart().length;
    start += inner;
    text = text.trim();
  }
  return { text, align, colspan, rowspan, left, right, from: start };
}

/**
 * `text` split at each `separator` outside braces, math and environments
 * (`\\` inside a `\makecell{…}` or a nested tabular is not a row's end).
 */
export function splitTop(text: string, separator: string, offset = 0): { text: string; from: number }[] {
  const parts: { text: string; from: number }[] = [];
  let depth = 0;
  let environments = 0;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "%") {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
      continue;
    }
    if (char === "\\") {
      if (depth === 0 && environments === 0 && text.startsWith(separator, at) && separator === "\\\\") {
        parts.push({ text: text.slice(start, at), from: offset + start });
        at += 1;
        start = at + 1;
        continue;
      }
      if (text.startsWith("\\begin", at)) environments++;
      else if (text.startsWith("\\end", at) && environments > 0) environments--;
      at++;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    else if (char === "$") {
      const close = text.indexOf("$", at + 1);
      if (close > at) at = close;
    } else if (depth === 0 && environments === 0 && text.startsWith(separator, at)) {
      parts.push({ text: text.slice(start, at), from: offset + start });
      start = at + separator.length;
      at = start - 1;
    }
  }
  parts.push({ text: text.slice(start), from: offset + start });
  return parts;
}
