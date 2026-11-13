/**
 * A float (`figure`, `table`, their starred and chemistry kin) read into the
 * layout Visual mode draws it as: rows of side-by-side panels (`minipage`,
 * `subfigure`, `\subfloat`, `\parbox`), each with its images, tables and
 * captions, as LaTeX sets them on the page. Layout and setup commands
 * (`\centering`, `\hfill`, `\captionsetup`, `\vspace`) are read for what they
 * mean or stepped over; wrappers (`\resizebox`, `adjustbox`, `center`) draw
 * what they hold; anything else (a TikZ picture, an unknown environment) is
 * a named placeholder, so the float always draws as something readable.
 *
 * Every node keeps where its source starts, so a click on it puts the caret
 * there. Nothing here edits the source.
 */
import { groupEnd } from "./visual-inline";
import { environmentClose } from "./visual-scan";
import { parseTable, TABLE_ENVIRONMENTS, type Table } from "./visual-table";

export type FloatNode =
  /** Things set side by side, wrapping onto new lines when the column is narrow. */
  | { kind: "row"; items: FloatNode[]; from: number }
  /** A `minipage`, `subfigure` or `\parbox`: its share of the line, and what it holds. */
  | { kind: "panel"; width: number | null; children: FloatNode[]; from: number }
  | { kind: "image"; path: string; width: number | null; from: number }
  /** `sub`: a subfigure's caption, lettered (a), (b)… */
  | { kind: "caption"; text: string; label: string | null; sub: boolean; type: string | null; from: number }
  | { kind: "table"; table: Table; from: number }
  | { kind: "text"; text: string; from: number }
  /** A `\label`: drawn as nothing, it names the caption before it. */
  | { kind: "label"; key: string; from: number }
  /** What is not drawn: a TikZ picture, an algorithm. */
  | { kind: "opaque"; name: string; from: number };

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX names */
/** Environments drawn as a panel of their own width. */
const PANELS = new Set(["minipage", "subfigure", "subtable", "subfloat"]);
/** Environments whose captions are a subfigure's. */
const SUB_PANELS = new Set(["subfigure", "subtable"]);
/** Environments that only place what they hold: drawn as their content. */
const WRAPPERS = new Set(["center", "adjustbox", "small", "footnotesize", "scriptsize", "flushleft", "flushright", "threeparttable", "tablenotes", "landscape", "sidewaystable", "sidewaysfigure", "tabularcentered"]);
/** Commands that print nothing in a float, with how many braced arguments they take. */
const SILENT = new Map<string, number>([
  ["centering", 0], ["raggedright", 0], ["raggedleft", 0], ["captionsetup", 1], ["vspace", 1], ["hspace", 1], ["vskip", 0],
  ["smallskip", 0], ["medskip", 0], ["bigskip", 0], ["hfill", 0], ["hfil", 0], ["vfill", 0], ["quad", 0], ["qquad", 0],
  ["noindent", 0], ["setlength", 2], ["addtolength", 2], ["small", 0], ["footnotesize", 0], ["scriptsize", 0], ["tiny", 0],
  ["normalsize", 0], ["large", 0], ["Large", 0], ["renewcommand", 2], ["setcounter", 2], ["addtocounter", 2], ["color", 1],
  ["arraystretch", 0], ["tabcolsep", 0], ["phantomsection", 0], ["FloatBarrier", 0], ["relax", 0], ["strut", 0],
  ["rowcolors", 3], ["definecolor", 3], ["sisetup", 1], ["captionsetup*", 1], ["ContinuedFloat", 0], ["linewidth", 0],
  ["textwidth", 0], ["columnwidth", 0], ["label", 1], ["par", 0], ["newline", 0], ["hline", 0],
]);
/** Commands that place one box: drawn as what their last argument holds. */
const BOX_WRAPPERS = new Map<string, number>([
  // How many arguments come before the content.
  ["resizebox", 2], ["resizebox*", 2], ["scalebox", 1], ["adjustbox", 1], ["makebox", 0], ["framebox", 0], ["fbox", 0],
  ["mbox", 0], ["centerline", 0], ["raisebox", 1], ["rotatebox", 1], ["colorbox", 1], ["fcolorbox", 2], ["hbox", 0],
  ["vbox", 0], ["vcenter", 0], ["centerbox", 0],
]);
/* eslint-enable lingui/no-unlocalized-strings */

/** The most nodes read from one float: a float with more is drawn up to it. */
const NODE_LIMIT = 300;
const DEPTH_LIMIT = 8;

/** A width as a share of the line: `0.49\linewidth` is 0.49, `5cm` a share of a 16.5 cm column. */
export function widthShare(value: string): number | null {
  const text = value.replace(/\s+/g, "");
  const relative = /^([\d.]*)\\(?:linewidth|textwidth|columnwidth|hsize|paperwidth)$/.exec(text);
  if (relative) {
    const share = relative[1] ? Number(relative[1]) : 1;
    return Number.isFinite(share) && share > 0 ? Math.min(share, 1) : null;
  }
  const absolute = /^([\d.]+)(cm|mm|in|pt|bp|em)$/.exec(text);
  if (!absolute) return null;
  const amount = Number(absolute[1]);
  const perLine = { cm: 16.5, mm: 165, in: 6.5, pt: 469, bp: 468, em: 47 }[absolute[2] as "cm"];
  return Number.isFinite(amount) && amount > 0 ? Math.min(amount / perLine, 1) : null;
}

/** The share of its box a graphic takes: `width=0.6\linewidth`, `width=\textwidth`, `scale=0.5`. */
export function imageShare(options: string): number | null {
  const width = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(options);
  if (width) return widthShare(width[1]);
  const scale = /(?:^|,)\s*scale\s*=\s*([\d.]+)/.exec(options);
  return scale ? Math.min(Number(scale[1]) || 1, 1) : null;
}

/**
 * The layout of the float `source` holds (from its `\begin` through its
 * `\end`), which starts at `offset` in the document.
 */
export function parseFloat(source: string, offset: number): FloatNode[] {
  const begin = /^\\begin\s*\{([^{}]+)\}\s*(?:\[[^\]]*\])?/.exec(source);
  const name = begin?.[1].trim() ?? "";
  const close = source.lastIndexOf(`\\end{${name}}`);
  let start = begin ? begin[0].length : 0;
  // `\begin{wrapfigure}[12]{r}[0pt]{0.4\textwidth}`: its placement and width are not content.
  if (/^wrap(?:figure|table)\*?$/.test(name)) {
    const placement = /^\s*\{[^{}]*\}\s*(?:\[[^\]]*\]\s*)?\{(?:[^{}]|\{[^{}]*\})*\}/.exec(source.slice(start));
    if (placement) start += placement[0].length;
  }
  const reader = new FloatReader(source, offset);
  const nodes = reader.blocks(start, close > start ? close : source.length, false, 0);
  numberCaptions(nodes);
  return nodes;
}

/** Each caption takes the first label after it and before the next caption, as LaTeX numbers it. */
function numberCaptions(nodes: FloatNode[]) {
  const ordered: FloatNode[] = [];
  const walk = (list: FloatNode[]) => {
    for (const node of list) {
      ordered.push(node);
      if (node.kind === "row") walk(node.items);
      if (node.kind === "panel") walk(node.children);
    }
  };
  walk(nodes);
  ordered.sort((a, b) => a.from - b.from);
  let open: Extract<FloatNode, { kind: "caption" }> | null = null;
  for (const node of ordered) {
    if (node.kind === "caption") open = node.label ? null : node;
    else if (node.kind === "label" && open) {
      open.label = node.key;
      open = null;
    }
  }
}

class FloatReader {
  private count = 0;

  constructor(private readonly source: string, private readonly offset: number) {}

  private skip(at: number): number {
    const { source } = this;
    for (;;) {
      while (at < source.length && /\s/.test(source[at])) at++;
      if (source[at] !== "%") return at;
      const line = source.indexOf("\n", at);
      at = line < 0 ? source.length : line + 1;
    }
  }

  /** The braced or bracketed group at `at` (after blanks), or null. */
  private group(at: number, open = "{"): { inner: string; from: number; end: number } | null {
    const start = this.skip(at);
    const end = groupEnd(this.source, start, open, open === "{" ? "}" : open === "[" ? "]" : ")");
    return end == null ? null : { inner: this.source.slice(start + 1, end - 1), from: start + 1, end };
  }

  /** Past any `[…]` options at `at`, at most `count`. */
  private options(at: number, count = 3): { end: number; values: string[] } {
    const values: string[] = [];
    for (let index = 0; index < count; index++) {
      const option = this.group(at, "[");
      if (!option) break;
      values.push(option.inner);
      at = option.end;
    }
    return { end: at, values };
  }

  /**
   * The blocks of `source[from, to)`: rows of panels and images, broken where
   * LaTeX ends a line (a blank line, `\\`, `\par`) or a caption, a table or
   * text comes between them.
   */
  blocks(from: number, to: number, sub: boolean, depth: number): FloatNode[] {
    const { source } = this;
    const blocks: FloatNode[] = [];
    let row: FloatNode[] = [];
    let text = "";
    let textFrom = -1;
    const flushText = () => {
      if (text.trim() && this.count < NODE_LIMIT) {
        this.count++;
        blocks.push({ kind: "text", text: text.trim(), from: this.offset + textFrom });
      }
      text = "";
      textFrom = -1;
    };
    const flushRow = () => {
      if (row.length === 1) blocks.push(row[0]);
      else if (row.length) blocks.push({ kind: "row", items: row, from: row[0].from });
      row = [];
    };
    const inline = (node: FloatNode) => {
      flushText();
      if (this.count++ < NODE_LIMIT) row.push(node);
    };
    const block = (node: FloatNode) => {
      flushText();
      flushRow();
      if (this.count++ < NODE_LIMIT) blocks.push(node);
    };
    const addText = (value: string, at: number) => {
      if (textFrom < 0 && value.trim()) textFrom = at;
      if (textFrom >= 0) text += value;
    };

    let at = from;
    while (at < to && this.count < NODE_LIMIT) {
      const char = source[at];
      if (char === "%") {
        const line = source.indexOf("\n", at);
        at = line < 0 || line > to ? to : line + 1;
        continue;
      }
      if (char === "\n" && /^\n[ \t]*\n/.test(source.slice(at, at + 40))) {
        flushText();
        flushRow();
        at++;
        continue;
      }
      if (char === "{" && textFrom >= 0) {
        // A group in a run of text (`\textbf{Ours}`'s argument) is the text's: kept whole for the inline renderer.
        const end = groupEnd(source, at);
        const close = end == null || end > to ? to : end;
        addText(source.slice(at, close), at);
        at = close;
        continue;
      }
      if (char === "{" || char === "}") {
        // A bare group outside text places what it holds: read through it.
        at++;
        continue;
      }
      if (char !== "\\") {
        addText(char, at);
        at++;
        continue;
      }
      const command = /^\\([A-Za-z@]+\*?|.)/.exec(source.slice(at, at + 64));
      if (!command) {
        at++;
        continue;
      }
      const name = command[1];
      let next = at + command[0].length;
      if (name === "\\" || name === "par" || name === "newline") {
        // `\\[4pt]`: a line break and its extra space.
        next = this.options(next, 1).end;
        flushText();
        flushRow();
        at = next;
        continue;
      }
      if (name === "begin") {
        const group = this.group(next);
        if (!group) {
          at = next;
          continue;
        }
        const environment = group.inner.trim();
        const end = environmentClose(source, environment, group.end);
        if (!end || end.end > to) {
          at = group.end;
          continue;
        }
        if (TABLE_ENVIRONMENTS.has(environment)) {
          const table = parseTable(source.slice(at, end.end), this.offset + at);
          if (table) block({ kind: "table", table, from: this.offset + at });
          else block({ kind: "opaque", name: environment, from: this.offset + at });
        } else if (PANELS.has(environment) && depth < DEPTH_LIMIT) {
          // `\begin{minipage}[pos][height][inner]{width}`; `\begin{subfigure}[pos]{width}`.
          const options = this.options(group.end);
          const width = this.group(options.end);
          const bodyFrom = width ? width.end : options.end;
          const children = this.blocks(bodyFrom, end.close, sub || SUB_PANELS.has(environment), depth + 1);
          inline({ kind: "panel", width: width ? widthShare(width.inner) : null, children, from: this.offset + at });
        } else if (WRAPPERS.has(environment) && depth < DEPTH_LIMIT) {
          const options = this.options(group.end, 1);
          let bodyFrom = options.end;
          if (environment === "adjustbox") bodyFrom = this.group(bodyFrom)?.end ?? bodyFrom;
          flushText();
          for (const node of this.blocks(bodyFrom, end.close, sub, depth + 1)) {
            if (node.kind === "panel" || node.kind === "image") inline(node);
            else block(node);
          }
        } else {
          block({ kind: "opaque", name: environment, from: this.offset + at });
        }
        at = end.end;
        continue;
      }
      if (name === "includegraphics" || name === "includegraphics*") {
        const options = this.options(next, 2);
        const path = this.group(options.end);
        if (path && !/[{}\\]/.test(path.inner) && path.inner.trim()) {
          inline({ kind: "image", path: path.inner.trim(), width: imageShare(options.values.join(",")), from: this.offset + at });
          at = path.end;
        } else {
          at = next;
        }
        continue;
      }
      if (name === "caption" || name === "subcaption" || name === "captionof" || name === "caption*") {
        let type: string | null = null;
        let after = next;
        if (name === "captionof") {
          const kind = this.group(after);
          type = kind?.inner.trim() ?? null;
          after = kind?.end ?? after;
        }
        const options = this.options(after, 1);
        const body = this.group(options.end);
        if (!body) {
          at = next;
          continue;
        }
        // A `\label` inside the caption's braces names it, as one after it would.
        const inner = /\\label\s*\{([^{}]*)\}/.exec(body.inner);
        block({
          kind: "caption", text: body.inner, label: inner ? inner[1].trim() : null, sub: sub || name === "subcaption",
          type: name === "caption*" ? "" : type, from: this.offset + body.from,
        });
        at = body.end;
        continue;
      }
      if (name === "label") {
        const key = this.group(next);
        if (key) {
          // Drawn as nothing; it names the caption before it.
          blocks.push({ kind: "label", key: key.inner.trim(), from: this.offset + at });
          at = key.end;
        } else at = next;
        continue;
      }
      if ((name === "subfloat" || name === "subcaptionbox" || name === "subcaptionbox*") && depth < DEPTH_LIMIT) {
        // `\subfloat[caption]{content}`, `\subcaptionbox{caption}[width]{content}`.
        const caption = name === "subfloat" ? this.group(next, "[") : this.group(next);
        let after = caption?.end ?? next;
        let width: number | null = null;
        if (name !== "subfloat") {
          const option = this.group(after, "[");
          if (option) {
            width = widthShare(option.inner);
            after = option.end;
          }
        } else {
          after = this.options(after, 1).end;
        }
        const content = this.group(after);
        if (!content) {
          at = after;
          continue;
        }
        const children = this.blocks(content.from, content.end - 1, true, depth + 1);
        if (caption && caption.inner.trim()) {
          children.push({ kind: "caption", text: caption.inner, label: null, sub: true, type: null, from: this.offset + caption.from });
        }
        inline({ kind: "panel", width, children, from: this.offset + at });
        at = content.end;
        continue;
      }
      if (name === "parbox" && depth < DEPTH_LIMIT) {
        // `\parbox[pos][height][inner]{width}{content}`.
        const options = this.options(next);
        const width = this.group(options.end);
        const content = width ? this.group(width.end) : null;
        if (!width || !content) {
          at = next;
          continue;
        }
        const children = this.blocks(content.from, content.end - 1, sub, depth + 1);
        // A parbox holding only a graphic is the graphic, at the parbox's width.
        if (children.length === 1 && children[0].kind === "image") inline(scaled(children[0], widthShare(width.inner)));
        else inline({ kind: "panel", width: widthShare(width.inner), children, from: this.offset + at });
        at = content.end;
        continue;
      }
      const wrapped = BOX_WRAPPERS.get(name) ?? BOX_WRAPPERS.get(name.replace(/\*$/, ""));
      if (wrapped !== undefined && depth < DEPTH_LIMIT) {
        let after = this.options(next, 2).end;
        for (let index = 0; index < wrapped; index++) after = this.options(this.group(after)?.end ?? after, 1).end;
        const content = this.group(after);
        if (!content) {
          at = next;
          continue;
        }
        for (const node of this.blocks(content.from, content.end - 1, sub, depth + 1)) {
          if (node.kind === "panel" || node.kind === "image") inline(node);
          else block(node);
        }
        at = content.end;
        continue;
      }
      if (name === "def" || name === "gdef") {
        // `\def\arraystretch{1.2}`: a definition prints nothing.
        const target = /^\s*\\(?:[A-Za-z@]+|.)(?:\s*#[1-9])*/.exec(source.slice(next));
        const body = target ? this.group(next + target[0].length) : null;
        at = body ? body.end : next;
        continue;
      }
      const silent = SILENT.get(name.replace(/\*$/, ""));
      if (silent !== undefined) {
        let after = this.options(next, 1).end;
        for (let index = 0; index < silent; index++) after = this.group(after)?.end ?? after;
        // `\renewcommand{\arraystretch}{1.2}`: its first argument is a command, not a group.
        if (name === "renewcommand" && source[this.skip(next)] === "\\") {
          const target = /^\\[A-Za-z@]+/.exec(source.slice(this.skip(next)));
          after = this.group(this.skip(next) + (target?.[0].length ?? 0))?.end ?? after;
        }
        at = after;
        continue;
      }
      // Anything else is text (a `\textbf{(a)}`, a `\ref`), set by the inline renderer.
      addText(command[0], at);
      at = next;
    }
    flushText();
    flushRow();
    return blocks;
  }
}

function scaled(image: Extract<FloatNode, { kind: "image" }>, box: number | null): FloatNode {
  if (box === null) return image;
  return { ...image, width: (image.width ?? 1) * box };
}
