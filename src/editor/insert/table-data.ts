import { buildTabularSnippet } from "./table-generator";

export type TableData = {
  cells: { text: string; latex: boolean }[][];
  align: ("l" | "c" | "r")[];
  decimals: number | null;
  booktabs: boolean;
  float: boolean;
  caption: string;
  label: string;
};

// eslint-disable-next-line lingui/no-unlocalized-strings -- versioned source marker, not UI copy
const START = "% lattice-table-v1 ";
// eslint-disable-next-line lingui/no-unlocalized-strings -- versioned source marker, not UI copy
const END = "% /lattice-table";

export function parseTableData(text: string, delimiter: "," | "\t"): string[][] | null {
  if (!text || text.length > 100_000) return null;
  const rows: string[][] = [[]];
  let value = "", quoted = false, closed = false;
  const push = () => { rows[rows.length - 1].push(value); value = ""; closed = false; };
  const source = text.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === delimiter) push();
    else if (char === "\n") { push(); rows.push([]); }
    else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') return null;
    else value += char;
    if (rows.length > 21 || rows[rows.length - 1].length > 20) return null;
  }
  if (quoted) return null;
  push();
  if (source.endsWith("\n")) rows.pop();
  const width = Math.max(...rows.map((row) => row.length));
  if (rows.length > 20 || width > 20) return null;
  return rows.map((row) => Array.from({ length: width }, (_, col) => row[col] ?? ""));
}

function escapeTableText(text: string): string {
  const escapes: Record<string, string> = {
    "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#",
    "_": "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
  };
  return text.replace(/[\\&%$#_{}~^]/g, (char) => escapes[char]).replace(/[\r\n]+/g, " ");
}

export function newTableData(): TableData {
  return {
    // eslint-disable-next-line lingui/no-unlocalized-strings -- sample data written into source
    cells: [["Col 1", "Col 2", "Col 3"], ["", "", ""], ["", "", ""]].map((row) => row.map((text) => ({ text, latex: false }))),
    align: ["l", "l", "l"], decimals: null, booktabs: true, float: true, caption: "", label: "",
  };
}

export function validTableData(value: unknown): value is TableData {
  if (!value || typeof value !== "object") return false;
  const d = value as TableData;
  return Array.isArray(d.cells) && d.cells.length > 0 && d.cells.length <= 20
    && Array.isArray(d.align) && d.align.length > 0 && d.align.length <= 20
    && d.align.every((align) => ["l", "c", "r"].includes(align))
    && d.cells.every((row) => Array.isArray(row) && row.length === d.align.length && row.every((cell) =>
      cell && typeof cell.text === "string" && cell.text.length <= 10_000 && typeof cell.latex === "boolean"
      // Raw math/macros are opt-in, but structural TeX stays in the source editor.
      && (!cell.latex || !/[\r\n%&]|\\\\|\\(?:begin|end)\b/.test(cell.text))))
    && (d.decimals === null || Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 8)
    && typeof d.booktabs === "boolean" && typeof d.float === "boolean"
    && typeof d.caption === "string" && typeof d.label === "string" && /^[\w:.-]*$/.test(d.label);
}

export function tableSource(data: TableData): string {
  return buildTabularSnippet({
    rows: data.cells.length, cols: data.align.length, ...data,
    caption: escapeTableText(data.caption),
    data: data.cells.map((row, r) => row.map((cell) => {
      if (cell.latex) return cell.text;
      let text = cell.text;
      if (r > 0 && data.decimals !== null && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text.trim())) {
        const number = Number(text);
        if (Number.isFinite(number)) text = number.toFixed(data.decimals);
      }
      return escapeTableText(text);
    })),
  }).insert;
}

export function managedTableSource(data: TableData): string {
  // Short comment lines stay below TeX's input-buffer limit even for large cells.
  const encoded = encodeURIComponent(JSON.stringify(data));
  const metadata = encoded.match(/.{1,120}/g)!.join("\n% ");
  return `${START}${metadata}\n${tableSource(data)}${END}\n`;
}

/** Only the exact generated subset is editable. Metadata never authorizes
 * rewriting a hand-edited body, malformed block, or an arbitrary tabular. */
export function tableAtCursor(source: string, cursor: number): {
  from: number; to: number; data: TableData | null;
} | null {
  const marker = /^% lattice-table-v1 .*$(?:\n% [A-Za-z0-9%_.!~*'()-]+$)*/gm;
  for (const match of source.matchAll(marker)) {
    const from = match.index;
    const end = source.indexOf(`\n${END}`, from);
    const to = end < 0 ? source.length : end + 1 + END.length + (source[end + 1 + END.length] === "\n" ? 1 : 0);
    if (cursor < from || cursor >= to) continue;
    try {
      const data: unknown = JSON.parse(decodeURIComponent(match[0].slice(START.length).replace(/\n% /g, "")));
      if (validTableData(data) && managedTableSource(data) === source.slice(from, to)) return { from, to, data };
    } catch { /* Malformed or older metadata remains source-only. */ }
    return { from, to, data: null };
  }
  // Detect unsupported table environments without interpreting or rewriting them.
  let depth = 0;
  for (const token of source.slice(0, cursor).matchAll(/\\(begin|end)\{(?:table\*?|tabular\*?)\}/g)) {
    depth = Math.max(0, depth + (token[1] === "begin" ? 1 : -1));
  }
  if (depth) return { from: cursor, to: cursor, data: null };
  return null;
}
