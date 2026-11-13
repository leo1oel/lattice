/**
 * A short run of LaTeX (a caption, a table cell, a title, an author block)
 * set as rich text for the blocks Visual mode draws whole: styles and font
 * switches, sizes, superscripts, spacing, line breaks, math through KaTeX,
 * references and citations as the chips the body draws, and the document's
 * own `\newcommand`/`\def` macros expanded first. What it cannot read is
 * left out rather than shown as commands: an unknown `\cmd{x}` prints `x`.
 *
 * The text is anyone's file, so the DOM is built node by node (KaTeX's own
 * HTML aside), and every loop is bounded by the input's length.
 */
import { element } from "../../dom-utils";
import { mathHtml } from "./visual-math";
import { ACCENTS, CITATION_COMMANDS, LITERALS, REFERENCE_COMMANDS, STYLE_COMMANDS, STYLE_SWITCHES } from "./visual-symbols";

/** What a run's references, citations and macros are read from. */
export type InlineContext = {
  /** The project's macros (`katexMacros`): `\name` to its body, `#1`… its arguments. */
  macros?: Record<string, string>;
  /** A reference's text: "3", "Figure 3". */
  reference?: (command: string, keys: string[]) => string;
  /** A citation's text: "[Vaswani et al., 2017]". */
  citation?: (command: string, keys: string[], notes: string[]) => string;
};

/** The longest run set: a caption or an author block is a few hundred characters. */
const INPUT_LIMIT = 20_000;
/** How many times macros are expanded inside one another, and how long the text may grow doing it. */
const EXPANSION_DEPTH = 8;
const EXPANSION_LIMIT = 40_000;

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command names */
/** Size switches and the class each sets. */
const SIZES: ReadonlyMap<string, string> = new Map([
  ["tiny", "xsmall"], ["scriptsize", "xsmall"], ["footnotesize", "small"], ["small", "small"], ["normalsize", "normal"],
  ["large", "large"], ["Large", "large"], ["LARGE", "xlarge"], ["huge", "xlarge"], ["Huge", "xlarge"],
]);
/** Commands that print nothing here, with how many braced arguments they take. */
const SILENT: ReadonlyMap<string, number> = new Map([
  ["label", 1], ["thanks", 1], ["footnote", 1], ["footnotemark", 0], ["footnotetext", 1], ["vspace", 1], ["captionsetup", 1],
  ["hypersetup", 1], ["color", 1], ["setlength", 2], ["addtolength", 2], ["phantom", 1], ["vphantom", 1], ["rule", 2],
  ["centering", 0], ["raggedright", 0], ["raggedleft", 0], ["noindent", 0], ["protect", 0], ["selectfont", 0], ["relax", 0],
  ["smallskip", 0], ["medskip", 0], ["bigskip", 0], ["vfill", 0], ["strut", 0], ["null", 0], ["nobreak", 0], ["unskip", 0],
  ["index", 1], ["glossary", 1], ["linewidth", 0], ["textwidth", 0], ["columnwidth", 0], ["fontsize", 2], ["fontfamily", 1],
  ["usefont", 4], ["fontseries", 1], ["fontshape", 1], ["addlinespace", 0], ["cellcolor", 1], ["rowcolor", 1], ["arraybackslash", 0],
]);
/** Horizontal space, as the class whose width it takes. */
const SPACES: ReadonlyMap<string, string> = new Map([
  ["quad", "quad"], ["qquad", "qquad"], ["enspace", "en"], ["enskip", "en"], ["thinspace", "thin"], ["hfill", "fill"], ["hfil", "fill"],
  [",", "thin"], [";", "en"], [":", "en"], [">", "en"], ["/", ""], ["!", ""], [" ", "word"],
]);
/* eslint-enable lingui/no-unlocalized-strings */

/** The arity of a macro body: its highest `#n`. */
function arity(body: string): number {
  let highest = 0;
  for (const match of body.matchAll(/#([1-9])/g)) highest = Math.max(highest, Number(match[1]));
  return highest;
}

/** The end of the group opening at `at` (`{…}`, or `[…]`), past its close; null when it does not close. */
export function groupEnd(text: string, at: number, open = "{", close = "}"): number | null {
  if (text[at] !== open) return null;
  let depth = 0;
  for (let index = at; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "{") depth++;
    else if (char === "}") {
      if (open === "{" && --depth === 0) return index + 1;
      if (open !== "{") depth--;
      if (depth < 0) return null;
    } else if (char === close && open !== "{" && depth === 0) return index + 1;
  }
  return null;
}

const skipBlanks = (text: string, at: number) => {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
};

/** One argument at `at` (a group's inside, or a single token), and where it ends; null at the text's end. */
function argument(text: string, at: number): { value: string; end: number } | null {
  at = skipBlanks(text, at);
  if (at >= text.length) return null;
  if (text[at] === "{") {
    const end = groupEnd(text, at);
    return end == null ? null : { value: text.slice(at + 1, end - 1), end };
  }
  if (text[at] === "\\") {
    const name = /^\\(?:[A-Za-z@]+|.)/.exec(text.slice(at))![0];
    return { value: name, end: at + name.length };
  }
  return { value: text[at], end: at + 1 };
}

/**
 * `text` with the project's text macros expanded (`\aff{1}` to
 * `\textsuperscript{1}`), a bounded number of levels deep. Math is left as
 * it is: KaTeX reads the same macros itself.
 */
function expandMacros(text: string, macros: Record<string, string> | undefined): string {
  if (!macros) return text;
  let current = text;
  for (let depth = 0; depth < EXPANSION_DEPTH; depth++) {
    let changed = false;
    let out = "";
    let at = 0;
    const pattern = /\\([A-Za-z@]+)|\\./g;
    for (let match = pattern.exec(current); match; match = pattern.exec(current)) {
      const name = match[1];
      const body = name ? macros[`\\${name}`] : undefined;
      if (body === undefined) continue;
      let end = match.index + match[0].length;
      const args: string[] = [];
      let complete = true;
      for (let index = 0; index < arity(body); index++) {
        const next = argument(current, end);
        if (!next) {
          complete = false;
          break;
        }
        args.push(next.value);
        end = next.end;
      }
      if (!complete) continue;
      // A control word swallows the blanks after it, as TeX reads it; a paragraph break stays.
      if (!args.length) {
        const next = skipBlanks(current, end);
        if (!current.slice(end, next).includes("\n\n")) end = next;
      }
      const expanded = body.replace(/#([1-9])/g, (_, n: string) => args[Number(n) - 1] ?? "");
      // A body ending in a control word would read the letters after it as part of its name.
      const joined = /\\[A-Za-z@]+$/.test(expanded) && /^[A-Za-z]/.test(current[end] ?? "");
      out += current.slice(at, match.index) + (joined ? `${expanded} ` : expanded);
      at = end;
      pattern.lastIndex = end;
      changed = true;
      if (out.length > EXPANSION_LIMIT) return current;
    }
    if (!changed) return current;
    current = out + current.slice(at);
    if (current.length > EXPANSION_LIMIT) return text;
  }
  return current;
}

/** A math run's end: the next unescaped `close`, or -1. */
function mathEnd(text: string, from: number, close: string): number {
  for (let index = text.indexOf(close, from); index >= 0; index = text.indexOf(close, index + 1)) {
    if (close === "$" && text[index - 1] === "\\") continue;
    return index;
  }
  return -1;
}

/**
 * `source` set as rich text in a fragment. Line breaks (`\\`, `\par`, a
 * blank line) are `<br>`s; whoever places the fragment decides its alignment.
 */
export function renderInline(source: string, context: InlineContext = {}): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const text = expandMacros(source.slice(0, INPUT_LIMIT), context.macros);
  new InlineWriter(text, context).write(fragment);
  return fragment;
}

/** The plain text `source` sets as: what a heading, a tooltip or a test reads. */
export function inlineText(source: string, context: InlineContext = {}): string {
  const holder = document.createElement("span");
  holder.append(renderInline(source, context));
  return holder.textContent ?? "";
}

class InlineWriter {
  private at = 0;
  /** Where text goes: the innermost style or group. */
  private parent: Node = document.createDocumentFragment();
  /** The parent each open group returns to at its `}`. */
  private readonly groups: Node[] = [];
  /** The switch spans open in the current group, outermost first. */
  private switches: HTMLElement[] = [];
  private pendingSpace = false;

  constructor(private readonly text: string, private readonly context: InlineContext) {}

  write(into: Node) {
    this.parent = into;
    this.run(this.text.length);
  }

  /** Whether nothing visible was written since the run's start or its last line break. */
  private lineStart = true;

  /** A pending space, written only between words: never at a line's start. */
  private flushSpace() {
    if (!this.pendingSpace) return;
    this.pendingSpace = false;
    if (!this.lineStart) this.appendText(" ");
  }

  private appendText(value: string) {
    const last = this.parent.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE) last.textContent += value;
    else this.parent.appendChild(document.createTextNode(value));
  }

  /** Text, with spaces collapsed as TeX reads them. */
  private append(value: string) {
    if (!value) return;
    this.flushSpace();
    this.appendText(value);
    this.lineStart = false;
  }

  private node<T extends Node>(child: T): T {
    this.flushSpace();
    this.parent.appendChild(child);
    this.lineStart = false;
    return child;
  }

  private lineBreak(extra: boolean) {
    this.pendingSpace = false;
    const last = this.parent.lastChild;
    if (last?.nodeType === Node.TEXT_NODE) last.textContent = last.textContent!.replace(/ +$/, "");
    this.parent.appendChild(element("br", extra ? "lx-tex-break-gap" : ""));
    this.lineStart = true;
  }

  /** Write `text[at, end)` into the current parent. */
  private run(end: number) {
    const { text } = this;
    while (this.at < end) {
      const char = text[this.at];
      if (char === "%") {
        const line = text.indexOf("\n", this.at);
        this.at = line < 0 || line > end ? end : skipIndent(text, line + 1);
      } else if (char === "\\") {
        this.command(end);
      } else if (char === "$") {
        this.math(end);
      } else if (char === "{") {
        const close = groupEnd(text, this.at);
        if (close == null || close > end) {
          this.at++;
          continue;
        }
        this.at++;
        this.groupInto(this.parent, close - 1);
        this.at = close;
      } else if (char === "}") {
        this.at++;
      } else if (char === "~") {
        this.append(" ");
        this.at++;
      } else if (/\s/.test(char)) {
        let next = this.at;
        let breaks = 0;
        while (next < end && /\s/.test(text[next])) {
          if (text[next] === "\n") breaks++;
          next++;
        }
        if (breaks >= 2) this.lineBreak(false);
        else this.pendingSpace = true;
        this.at = next;
      } else if (char === "-" && text.startsWith("---", this.at)) {
        this.append("—");
        this.at += 3;
      } else if (char === "-" && text[this.at + 1] === "-") {
        this.append("–");
        this.at += 2;
      } else if (char === "`" || char === "'") {
        const double = text[this.at + 1] === char;
        this.append(char === "`" ? (double ? "“" : "‘") : (double ? "”" : "’"));
        this.at += double ? 2 : 1;
      } else {
        let stop = this.at + 1;
        while (stop < end && !/[\\%${}~\s`'-]/.test(text[stop])) stop++;
        this.append(text.slice(this.at, stop));
        this.at = stop;
      }
    }
  }

  /** `text[at, end)` written into `parent`, then back to where it was: a group's switches end with it. */
  private groupInto(parent: Node, end: number) {
    const outer = this.parent;
    const outerSwitches = this.switches;
    this.groups.push(outer);
    this.parent = parent;
    this.switches = [];
    this.run(end);
    this.parent = this.groups.pop()!;
    this.switches = outerSwitches;
  }

  /** A braced argument at the cursor written into `parent`; a bare token is written as one. */
  private argumentInto(parent: Node, end: number) {
    const { text } = this;
    this.at = skipBlanks(text, this.at);
    if (text[this.at] !== "{") {
      const token = argument(text, this.at);
      if (!token || token.end > end) return;
      const inner = new InlineWriter(token.value, this.context);
      inner.write(parent);
      this.at = token.end;
      return;
    }
    const close = groupEnd(text, this.at);
    if (close == null || close > end) {
      this.at = end;
      return;
    }
    this.at++;
    this.groupInto(parent, close - 1);
    this.at = close;
  }

  /** The braced argument at the cursor as raw text, the cursor past it. */
  private rawArgument(end: number): string | null {
    const next = argument(this.text, this.at);
    if (!next || next.end > end) return null;
    this.at = next.end;
    return next.value;
  }

  private skipOptions(end: number, count = 3) {
    const { text } = this;
    for (let index = 0; index < count; index++) {
      const at = skipBlanks(text, this.at);
      const close = groupEnd(text, at, "[", "]");
      if (close == null || close > end) return;
      this.at = close;
    }
  }

  private skipParens(end: number) {
    const at = skipBlanks(this.text, this.at);
    const close = groupEnd(this.text, at, "(", ")");
    if (close != null && close <= end) this.at = close;
  }

  private math(end: number) {
    const { text } = this;
    const display = text[this.at + 1] === "$";
    const open = display ? 2 : 1;
    const close = mathEnd(text, this.at + open, display ? "$$" : "$");
    if (close < 0 || close >= end) {
      this.append("$");
      this.at++;
      return;
    }
    this.formula(text.slice(this.at + open, close));
    this.at = close + open;
  }

  private formula(source: string) {
    const span = this.node(element("span", "lx-tex-math"));
    const html = mathHtml(source, false, this.context.macros);
    if (html === null) {
      span.classList.add("is-unset");
      span.textContent = source;
    } else {
      span.innerHTML = html;
    }
  }

  private styled(className: string, end: number, tag: "span" | "sup" | "sub" = "span") {
    const span = this.node(element(tag, className));
    this.argumentInto(span, end);
  }

  /**
   * A switch (`\bfseries`, `\small`) styles the rest of its group: what
   * follows goes into its span until the group closes. A size is absolute, so
   * a new one closes the size open in the group and reopens the switches set
   * inside it.
   */
  private switchTo(className: string) {
    let reopen: string[] = [];
    if (isSize(className)) {
      const open = this.switches.findIndex((span) => isSize(span.className));
      if (open >= 0) {
        const closed = this.switches.splice(open);
        this.parent = closed[0].parentNode!;
        reopen = closed.slice(1).map((span) => span.className);
      }
    }
    for (const name of [className, ...reopen]) {
      const span = element("span", name);
      this.parent.appendChild(span);
      this.parent = span;
      this.switches.push(span);
    }
  }

  private command(end: number) {
    const { text } = this;
    const start = this.at;
    const match = /^\\(?:([A-Za-z@]+)\*?|(.))/s.exec(text.slice(start, Math.min(end, start + 64)));
    if (!match) {
      this.at++;
      return;
    }
    this.at = start + match[0].length;
    const name = match[1];
    if (!name) return this.controlSymbol(match[2], end);
    // A control word swallows the spaces after it.
    if (/\s/.test(text[this.at] ?? "") && !SPACES.has(name)) {
      const next = skipBlanks(text, this.at);
      if (!text.slice(this.at, next).includes("\n\n")) this.at = next;
    }
    const style = STYLE_COMMANDS.get(name);
    if (style === "link") {
      const url = this.rawArgument(end);
      if (url != null) this.node(element("span", "lx-tex-link", url));
      return;
    }
    if (style === "footnote") {
      this.rawArgument(end);
      return;
    }
    if (style) return this.styled(`lx-tex-${style}`, end);
    if (name === "textsuperscript") return this.styled("lx-tex-sup", end, "sup");
    if (name === "textsubscript") return this.styled("lx-tex-sub", end, "sub");
    if (name === "href") {
      this.rawArgument(end);
      return this.styled("lx-tex-link", end);
    }
    if (name === "textcolor" || name === "colorbox") {
      this.skipOptions(end, 1);
      this.rawArgument(end);
      return this.styled("", end);
    }
    if (name === "normalfont") return this.switchTo("lx-tex-normalfont");
    const switched = STYLE_SWITCHES.get(name);
    if (switched) return this.switchTo(`lx-tex-${switched}`);
    const size = SIZES.get(name);
    if (size) return this.switchTo(`lx-tex-size-${size}`);
    const space = SPACES.get(name);
    if (space !== undefined) return this.space(space);
    if (name === "hspace") {
      this.rawArgument(end);
      return this.space("en");
    }
    if (name === "par" || name === "newline" || name === "linebreak") {
      this.skipOptions(end, 1);
      return this.lineBreak(name === "par");
    }
    if (REFERENCE_COMMANDS.has(name) || CITATION_COMMANDS.has(name)) return this.keys(name, end);
    const silent = SILENT.get(name);
    if (silent !== undefined) {
      this.skipOptions(end, 1);
      for (let index = 0; index < silent; index++) this.rawArgument(end);
      return;
    }
    if (name === "cmidrule") {
      this.skipParens(end);
      this.rawArgument(end);
      return;
    }
    const accent = ACCENTS[name];
    if (accent !== undefined) return this.accent(accent, end);
    const literal = LITERALS[name];
    if (literal !== undefined) {
      if (text.startsWith("{}", this.at)) this.at += 2;
      return this.append(literal);
    }
    // Anything else (`\makecell{…}`, `\mbox{…}`, a package's command): its text, its own name left out.
    this.skipOptions(end);
    for (let guard = 0; guard < 4 && text[skipBlanks(text, this.at)] === "{"; guard++) {
      this.at = skipBlanks(text, this.at);
      this.argumentInto(this.parent, end);
    }
  }

  private controlSymbol(char: string, end: number) {
    const { text } = this;
    if (char === "\\") {
      if (text[this.at] === "*") this.at++;
      const options = groupEnd(text, skipBlanks(text, this.at), "[", "]");
      const extra = options != null && options <= end;
      if (extra) this.at = options;
      return this.lineBreak(extra);
    }
    if (char === "(" || char === "[") {
      const close = text.indexOf(char === "(" ? "\\)" : "\\]", this.at);
      if (close < 0 || close >= end) return;
      this.formula(text.slice(this.at, close));
      this.at = close + 2;
      return;
    }
    const space = SPACES.get(char);
    if (space !== undefined) return this.space(space);
    const accent = ACCENTS[char];
    if (accent !== undefined) return this.accent(accent, end);
    const literal = LITERALS[char];
    if (literal !== undefined) this.append(literal);
  }

  private accent(mark: string, end: number) {
    const letter = this.rawArgument(end);
    if (letter == null) return;
    const base = letter === "\\i" ? "i" : letter === "\\j" ? "j" : letter;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a Unicode normalization form
    this.append(/^[A-Za-z]$/.test(base) ? (base + mark).normalize("NFC") : base);
  }

  private space(kind: string) {
    if (!kind) return;
    if (kind === "word") {
      this.append(" ");
      return;
    }
    this.pendingSpace = false;
    this.parent.appendChild(element("span", ["lx-tex-space", `is-${kind}`].join(" ")));
    this.lineStart = false;
  }

  private keys(name: string, end: number) {
    const citation = CITATION_COMMANDS.has(name);
    const notes: string[] = [];
    for (let index = 0; index < (citation ? 2 : 0); index++) {
      const at = skipBlanks(this.text, this.at);
      const close = groupEnd(this.text, at, "[", "]");
      if (close == null || close > end) break;
      notes.push(this.text.slice(at + 1, close - 1));
      this.at = close;
    }
    const raw = this.rawArgument(end);
    if (raw == null) return;
    const keys = raw.split(",").map((key) => key.trim()).filter(Boolean);
    if (!keys.length) return;
    const shown = citation
      ? this.context.citation?.(name, keys, notes) ?? `[${keys.join(", ")}]`
      : this.context.reference?.(name, keys) ?? "?";
    this.node(element("span", citation ? "lx-tex-cite" : "lx-tex-ref", shown)).title = keys.join(", ");
  }
}

const isSize = (className: string) => className.startsWith("lx-tex-size-");

function skipIndent(text: string, at: number): number {
  while (text[at] === " " || text[at] === "\t") at++;
  return at;
}
