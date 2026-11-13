/**
 * The constructs Visual mode draws in a stretch of LaTeX source, each with
 * the exact source offsets it covers. A hand-written scanner rather than a
 * parser (Lattice has no LaTeX syntax tree, see latex-language.ts): one pass,
 * linear in the text it is given, which is only what is on screen and a
 * margin around it. Whatever it cannot read for certain (an unclosed brace,
 * math that does not end, a command it does not know) yields no construct, so
 * that source stays as written.
 */
import {
  ACCENTS, BOXED_ENVIRONMENTS, CITATION_COMMANDS, COMPOUND_COMMANDS, DISPLAY_MATH_ENVIRONMENTS, FIGURE_ENVIRONMENTS,
  HEADING_LEVELS, IMPORT_COMMANDS, INCLUDE_COMMANDS, LAYOUT_COMMANDS, LIST_ENVIRONMENTS, LITERALS, MARKER_COMMANDS, REFERENCE_COMMANDS,
  SIZE_SWITCHES, SOURCE_ENVIRONMENTS, STYLE_COMMANDS, STYLE_SWITCHES, TABLE_ENVIRONMENTS, type TextStyle,
} from "./visual-symbols";

export type Span = { from: number; to: number };
type ListKind = "itemize" | "enumerate" | "description";

/** Something Visual mode draws, and the source `[from, to)` it stands for. */
export type Construct = Span & (
  /** Styled text: `open` and `close` (`\textbf{`, `}`) are hidden, what is between them is styled. */
  | { kind: "style"; style: TextStyle; open: Span; close: Span }
  /** A sectioning command; its title is drawn as a heading. */
  | { kind: "heading"; level: number; open: Span; close: Span }
  /** A float's caption, and the label its float gives it (what the last build numbered). */
  | { kind: "caption"; open: Span; close: Span; float: string | null; label: string | null }
  /** `\href{url}{text}`: the text, drawn as a link. */
  | { kind: "link"; open: Span; close: Span; url: string }
  /** Inline or display math; `body` is the math between the delimiters. */
  | { kind: "math"; display: boolean; body: Span; environment: string | null }
  /** A character or word an escape, accent, ligature or command stands for. */
  | { kind: "symbol"; text: string }
  | { kind: "reference"; command: string; keys: string[] }
  | { kind: "citation"; command: string; keys: string[]; notes: string[] }
  | { kind: "label"; key: string }
  /** `\input{…}`, or the `import` package's `\import{dir/}{file}` with `path` the two joined. */
  | { kind: "include"; command: string; path: string }
  /** chemnum's `\cmpd{a,b}` and its relatives: the keys whose numbers it prints. */
  | { kind: "compound"; command: string; keys: string[] }
  /** An `\item`: `index` counts from 1 within its list; `term` is a description item's `[…]`. */
  | { kind: "item"; list: ListKind; depth: number; index: number; term: Span | null }
  /** The `\begin{…}` or `\end{…}` token of an environment Visual mode knows, with its `[…]` argument. */
  | { kind: "environment"; name: string; begin: boolean; depth: number; argument: string | null }
  | { kind: "image"; path: string; options: string }
  /** `\maketitle`: the title block the preamble's `\title` and `\author` describe. */
  | { kind: "title" }
  /**
   * A whole float (`figure`, `table`, …) or a table outside one, from its
   * `\begin` through its `\end`: drawn as one block, its layout read from its source.
   */
  | { kind: "block"; name: string }
  /** A command standing for a part of the document: `\appendix`, `\bibliography{…}`. */
  | { kind: "marker"; marker: "appendix" | "references" }
  /** A group spanning lines that `\centering` centers: `{\centering … \par}`. */
  | { kind: "centered" }
);

/** A construct before it is placed: what `Scanner.push` takes. */
type Unplaced = Construct extends infer C ? C extends Construct ? Omit<C, "from" | "to"> : never : never;

/**
 * An environment open where a scan starts, and (for a list) how many items
 * it has had. `start` is where its constructs begin in the scan's list, for a
 * float to number its caption from its label once it ends.
 */
export type ScanFrame = { name: string; items: number; start?: number; at?: number };

type Frame =
  | { type: "group"; at: number; bare: boolean; centered?: boolean }
  | { type: "style"; at: number; style: TextStyle; open: Span }
  | { type: "heading"; at: number; level: number; open: Span }
  | { type: "caption"; at: number; open: Span; float: string | null }
  | { type: "link"; at: number; open: Span; url: string };

/** Where the next character the scanner acts on is, from `at`. */
const SPECIAL = /[%\\${}`'~-]/g;
const isLetter = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 64;
/** The longest key list or path the scanner reads: anything longer is not one. */
const ARGUMENT_LIMIT = 1_000;

/**
 * Scan `text`, which starts at `offset` in the document, with `open` the
 * environments already open there (outermost first; lists with their item
 * counts so far). Returns the constructs found, in source order of their
 * start, and the environments open at the end of `text`.
 */
export function scanConstructs(text: string, offset: number, open: readonly ScanFrame[] = []): { constructs: Construct[]; open: ScanFrame[] } {
  return new Scanner(text, offset, open).run();
}

class Scanner {
  private readonly constructs: Construct[] = [];
  private readonly frames: Frame[] = [];
  private readonly environments: ScanFrame[];

  constructor(private readonly text: string, private readonly offset: number, open: readonly ScanFrame[]) {
    this.environments = open.map((frame) => ({ ...frame }));
  }

  run(): { constructs: Construct[]; open: ScanFrame[] } {
    const { text } = this;
    const special = new RegExp(SPECIAL.source, "g");
    let at = 0;
    while (at < text.length) {
      special.lastIndex = at;
      const match = special.exec(text);
      if (!match) break;
      at = this.step(match.index);
    }
    this.constructs.sort((a, b) => a.from - b.from || b.to - a.to);
    return { constructs: this.constructs, open: this.environments };
  }

  /** Act on the special character at `at`; where scanning goes on. */
  private step(at: number): number {
    const { text } = this;
    switch (text[at]) {
      case "%": return this.lineEnd(at);
      case "\\": return this.command(at);
      case "$": return this.dollar(at);
      case "{":
        this.frames.push({ type: "group", at, bare: bareGroupAt(text, at) });
        return at + 1;
      case "}":
        this.close(at);
        return at + 1;
      case "`":
        if (this.mono()) return at + 1;
        if (text[at + 1] === "`") return this.symbol(at, at + 2, "“");
        return this.symbol(at, at + 1, "‘");
      case "'":
        return text[at + 1] === "'" && !this.mono() ? this.symbol(at, at + 2, "”") : at + 1;
      case "~":
        return this.symbol(at, at + 1, " ");
      case "-":
        if (this.mono()) return at + 1;
        if (text.startsWith("---", at)) return this.symbol(at, at + 3, "—");
        if (text[at + 1] === "-") return this.symbol(at, at + 2, "–");
        return at + 1;
      default: return at + 1;
    }
  }

  /** Whether the text at hand is typewriter text, whose fonts have no dash or quote ligatures. */
  private mono(): boolean {
    return this.frames.some((frame) => frame.type === "style" && frame.style === "mono");
  }

  private lineEnd(at: number): number {
    const end = this.text.indexOf("\n", at);
    return end < 0 ? this.text.length : end;
  }

  private span(from: number, to: number): Span {
    return { from: this.offset + from, to: this.offset + to };
  }

  private push(from: number, to: number, construct: Unplaced) {
    this.constructs.push({ ...construct, from: this.offset + from, to: this.offset + to });
  }

  private symbol(from: number, to: number, symbol: string): number {
    this.push(from, to, { kind: "symbol", text: symbol });
    return to;
  }

  /** A `}`: it closes the innermost group, and the construct that group was the argument of. */
  private close(at: number) {
    const frame = this.frames.pop();
    if (!frame) return;
    if (frame.type === "group") {
      // A bare group across lines (`{\centering\small …\par}`) only scopes what is in it: its braces print nothing.
      if (frame.bare && this.text.slice(frame.at, at).includes("\n")) {
        this.push(frame.at, frame.at + 1, { kind: "symbol", text: "" });
        this.push(at, at + 1, { kind: "symbol", text: "" });
        if (frame.centered) this.push(frame.at, at + 1, { kind: "centered" });
      }
      return;
    }
    const close = this.span(at, at + 1);
    const from = frame.open.from - this.offset;
    switch (frame.type) {
      case "style": this.push(from, at + 1, { kind: "style", style: frame.style, open: frame.open, close }); break;
      case "heading": this.push(from, at + 1, { kind: "heading", level: frame.level, open: frame.open, close }); break;
      case "caption": this.push(from, at + 1, { kind: "caption", open: frame.open, close, float: frame.float, label: null }); break;
      case "link": this.push(from, at + 1, { kind: "link", open: frame.open, close, url: frame.url }); break;
    }
  }

  /** Past spaces and tabs (not line breaks) from `at`. */
  private spaces(at: number): number {
    while (this.text[at] === " " || this.text[at] === "\t") at++;
    return at;
  }

  /**
   * The group at `at` (`{…}`, or `[…]` when `open` is a bracket), as its
   * inside and end. Braces inside balance, escapes are stepped over; null
   * when none closes before a blank line or `ARGUMENT_LIMIT`.
   */
  private group(at: number, open = "{", close = "}"): { inner: string; end: number } | null {
    const { text } = this;
    if (text[at] !== open) return null;
    const limit = Math.min(text.length, at + ARGUMENT_LIMIT);
    let depth = 0;
    for (let index = at + 1; index < limit; index++) {
      const char = text[index];
      if (char === "\\") index++;
      else if (char === "\n" && blankLineAt(text, index)) return null;
      else if (char === "{") depth++;
      else if (char === "}") {
        if (depth === 0) return close === "}" ? { inner: text.slice(at + 1, index), end: index + 1 } : null;
        depth--;
      } else if (char === close && depth === 0) return { inner: text.slice(at + 1, index), end: index + 1 };
    }
    return null;
  }

  /** Past optional `[…]` arguments (at most `count`) after `at`. */
  private options(at: number, count: number): { end: number; values: string[] } {
    const values: string[] = [];
    for (let index = 0; index < count; index++) {
      const option = this.group(this.spaces(at), "[", "]");
      if (!option) break;
      values.push(option.inner);
      at = option.end;
    }
    return { end: at, values };
  }

  /** A math region's end: the next `close` not escaped, before any blank line; null when there is none. */
  private mathEnd(from: number, close: string): number | null {
    const { text } = this;
    for (let index = text.indexOf(close, from); index >= 0; index = text.indexOf(close, index + 1)) {
      if (blankLineBetween(text, from, index)) return null;
      if (text[index - 1] === "\\" && close === "$") continue;
      return index;
    }
    return null;
  }

  private dollar(at: number): number {
    const { text } = this;
    const display = text[at + 1] === "$";
    const open = display ? 2 : 1;
    const end = this.mathEnd(at + open, display ? "$$" : "$");
    if (end == null || end === at + open) return at + open;
    this.push(at, end + open, { kind: "math", display, body: this.span(at + open, end), environment: null });
    return end + open;
  }

  private command(at: number): number {
    const { text } = this;
    const first = text.charCodeAt(at + 1);
    if (Number.isNaN(first)) return at + 1;
    if (!isLetter(first)) return this.controlSymbol(at);
    let end = at + 2;
    while (end < text.length && isLetter(text.charCodeAt(end))) end++;
    const name = text.slice(at + 1, end);
    if (name === "begin" || name === "end") return this.environment(at, end, name === "begin");
    if (name === "item") return this.item(at, end);
    if (name === "verb") return this.verb(end);
    const style = STYLE_COMMANDS.get(name);
    if (style) return this.styleCommand(at, end, style);
    const level = HEADING_LEVELS.get(name);
    if (level != null) return this.heading(at, end, level);
    if (STYLE_SWITCHES.has(name)) return this.styleSwitch(at, end, STYLE_SWITCHES.get(name)!);
    if (REFERENCE_COMMANDS.has(name) || CITATION_COMMANDS.has(name)) return this.keys(at, end, name);
    if (name === "label") return this.label(at, end);
    if (INCLUDE_COMMANDS.has(name)) return this.include(at, end, name);
    if (IMPORT_COMMANDS.has(name)) return this.importFile(at, end, name);
    if (COMPOUND_COMMANDS.has(name)) return this.compound(at, end, name);
    if (name === "includegraphics") return this.image(at, end);
    if (name === "caption") return this.caption(at, end);
    if (name === "href") return this.href(at, end);
    if (name === "maketitle") {
      this.push(at, end, { kind: "title" });
      return end;
    }
    const marker = MARKER_COMMANDS.get(name);
    if (marker) return this.marker(at, end, name, marker);
    if (name === "centering") {
      // Floats are centered anyway; a group it opens centers its lines.
      const top = this.frames.at(-1);
      if (top?.type === "group") top.centered = true;
      return this.symbol(at, end, "");
    }
    if (SIZE_SWITCHES.has(name)) return this.sizeSwitch(at, end, SIZE_SWITCHES.get(name)!);
    const layout = LAYOUT_COMMANDS.get(name);
    if (layout !== undefined) return this.layout(at, end, layout);
    const accent = ACCENTS[name];
    if (accent != null) return this.accent(at, end, accent, true);
    const literal = LITERALS[name];
    if (literal != null) return this.symbol(at, text.startsWith("{}", end) ? end + 2 : end, literal);
    return end;
  }

  /** `\` and one non-letter: an escape, an accent, `\(`/`\[` math, or `\\`. */
  private controlSymbol(at: number): number {
    const { text } = this;
    const char = text[at + 1];
    if (char === "(" || char === "[") {
      const close = char === "(" ? "\\)" : "\\]";
      const end = this.mathEnd(at + 2, close);
      if (end == null) return at + 2;
      this.push(at, end + 2, { kind: "math", display: char === "[", body: this.span(at + 2, end), environment: null });
      return end + 2;
    }
    const accent = ACCENTS[char];
    if (accent != null) return this.accent(at, at + 2, accent, false);
    const literal = LITERALS[char];
    if (literal != null) return this.symbol(at, at + 2, literal);
    return at + 2;
  }

  /** `\'e`, `\'{e}`, `\c c`: the letter with its accent. */
  private accent(at: number, end: number, mark: string, named: boolean): number {
    const { text } = this;
    let from = end;
    if (named) {
      if (text[from] !== " " && text[from] !== "{") return end;
      from = this.spaces(from);
    }
    const group = this.group(from);
    const letter = group ? group.inner : text[from];
    const stop = group ? group.end : from + 1;
    if (!letter || !/^\\?[A-Za-z]$/.test(letter)) return end;
    const base = letter === "\\i" ? "i" : letter === "\\j" ? "j" : letter;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- a Unicode normalization form
    return this.symbol(at, stop, (base + mark).normalize("NFC"));
  }

  private verb(end: number): number {
    const { text } = this;
    const delimiter = text[end] === "*" ? end + 1 : end;
    const char = text[delimiter];
    if (!char || /[\sA-Za-z]/.test(char)) return end;
    const close = text.indexOf(char, delimiter + 1);
    const line = text.indexOf("\n", delimiter + 1);
    return close >= 0 && (line < 0 || close < line) ? close + 1 : end;
  }

  /**
   * A layout or setup command (`\vspace{4pt}`, `\newpage`, `\hypersetup{…}`):
   * it prints no text, so it draws as nothing, its source kept as written.
   * Null arguments when they cannot be read: the command then stays as source.
   */
  private layout(at: number, end: number, braced: number): number {
    let next = this.text[end] === "*" ? end + 1 : end;
    next = this.options(next, 1).end;
    for (let index = 0; index < braced; index++) {
      const group = this.group(this.spaces(next));
      if (!group) return end;
      next = group.end;
    }
    // `\noindent Text`: the space ending the control word goes with it.
    if (braced === 0 && next === end && this.text[next] === " ") next++;
    return this.symbol(at, next, "");
  }

  /** `\appendix`, `\bibliography{refs}`, `\printbibliography[…]`: the part of the document they begin. */
  private marker(at: number, end: number, name: string, marker: "appendix" | "references"): number {
    let next = this.options(end, 1).end;
    if (name === "bibliography") {
      const group = this.group(this.spaces(next));
      if (!group) return end;
      next = group.end;
    }
    this.push(at, next, { kind: "marker", marker });
    return next;
  }

  /** A size switch: at a group's start it sizes the group (`{\small …}`), elsewhere it draws as nothing. */
  private sizeSwitch(at: number, end: number, style: TextStyle): number {
    const top = this.frames.at(-1);
    if (top?.type === "group" && this.spaces(top.at + 1) === at) return this.styleSwitch(at, end, style);
    return this.symbol(at, this.text[end] === " " ? end + 1 : end, "");
  }

  private styleCommand(at: number, end: number, style: TextStyle): number {
    const brace = this.spaces(end);
    if (this.text[brace] !== "{") return end;
    if (style === "link") {
      // `\url` reads its argument verbatim: `%`, `#` and `_` in it are the address.
      const group = this.group(brace);
      if (!group) return end;
      this.push(at, group.end, { kind: "style", style, open: this.span(at, brace + 1), close: this.span(group.end - 1, group.end) });
      return group.end;
    }
    this.frames.push({ type: "style", at: brace, style, open: this.span(at, brace + 1) });
    return brace + 1;
  }

  /** `{\bf …}`: a switch at the very start of a group styles the rest of it. */
  private styleSwitch(at: number, end: number, style: TextStyle): number {
    const top = this.frames.at(-1);
    if (!top || top.type !== "group" || this.spaces(top.at + 1) !== at) return end;
    const after = this.text[end] === " " ? end + 1 : end;
    this.frames[this.frames.length - 1] = { type: "style", at: top.at, style, open: this.span(top.at, after) };
    return after;
  }

  private heading(at: number, end: number, level: number): number {
    let next = this.text[end] === "*" ? end + 1 : end;
    next = this.spaces(this.options(next, 1).end);
    if (this.text[next] !== "{") return end;
    this.frames.push({ type: "heading", at: next, level, open: this.span(at, next + 1) });
    return next + 1;
  }

  private caption(at: number, end: number): number {
    const next = this.spaces(this.options(end, 1).end);
    if (this.text[next] !== "{") return end;
    const float = [...this.environments].reverse().find((frame) => FIGURE_ENVIRONMENTS.has(frame.name))?.name ?? null;
    this.frames.push({ type: "caption", at: next, open: this.span(at, next + 1), float });
    return next + 1;
  }

  private href(at: number, end: number): number {
    const url = this.group(this.spaces(end));
    if (!url) return end;
    const text = this.spaces(url.end);
    if (this.text[text] !== "{") return end;
    this.frames.push({ type: "link", at: text, open: this.span(at, text + 1), url: url.inner.trim() });
    return text + 1;
  }

  /** `\ref{…}`, `\cite[…][…]{a,b}`: a key list, and a citation's notes. */
  private keys(at: number, end: number, name: string): number {
    const citation = CITATION_COMMANDS.has(name);
    let next = this.text[end] === "*" ? end + 1 : end;
    const options = citation ? this.options(next, 2) : { end: next, values: [] };
    next = this.spaces(options.end);
    const group = this.group(next);
    if (!group || /[{}\\]/.test(group.inner)) return end;
    const keys = group.inner.split(",").map((key) => key.trim()).filter(Boolean);
    if (!keys.length) return end;
    this.push(at, group.end, citation
      ? { kind: "citation", command: name, keys, notes: options.values }
      : { kind: "reference", command: name, keys });
    return group.end;
  }

  private label(at: number, end: number): number {
    const group = this.group(this.spaces(end));
    if (!group || /[{}\\]/.test(group.inner) || !group.inner.trim()) return end;
    this.push(at, group.end, { kind: "label", key: group.inner.trim() });
    return group.end;
  }

  private include(at: number, end: number, name: string): number {
    const group = this.group(this.spaces(end));
    if (!group || /[{}\\]/.test(group.inner) || !group.inner.trim()) return end;
    this.push(at, group.end, { kind: "include", command: name, path: group.inner.trim() });
    return group.end;
  }

  /** `\import{dir/}{file}`: a folder and a file in it, read as one path. */
  private importFile(at: number, end: number, name: string): number {
    const folder = this.group(this.spaces(end));
    if (!folder || /[{}\\]/.test(folder.inner)) return end;
    const file = this.group(this.spaces(folder.end));
    if (!file || /[{}\\]/.test(file.inner) || !file.inner.trim()) return end;
    const directory = folder.inner.trim().replace(/\/*$/, "");
    const path = directory ? `${directory}/${file.inner.trim()}` : file.inner.trim();
    this.push(at, file.end, { kind: "include", command: name, path });
    return file.end;
  }

  /** `\cmpd[options]{a,b}`, `\rcmpd{mark}`: the keys a compound number is printed for. */
  private compound(at: number, end: number, name: string): number {
    // `\cmpd*` only labels a compound: it prints nothing.
    if (this.text[end] === "*") return end + 1;
    const options = name === "rcmpd" ? { end, values: [] } : this.options(end, 1);
    const group = this.group(this.spaces(options.end));
    if (!group || /[{}\\]/.test(group.inner)) return end;
    const keys = name === "rcmpd" ? [group.inner.trim()] : group.inner.split(",").map((key) => key.trim());
    if (!keys.length || keys.some((key) => !key)) return end;
    this.push(at, group.end, { kind: "compound", command: name, keys });
    return group.end;
  }

  private image(at: number, end: number): number {
    let next = this.text[end] === "*" ? end + 1 : end;
    const options = this.options(next, 2);
    next = this.spaces(options.end);
    const group = this.group(next);
    if (!group || /[{}\\]/.test(group.inner) || !group.inner.trim()) return end;
    this.push(at, group.end, { kind: "image", path: group.inner.trim(), options: options.values.join(",") });
    return group.end;
  }

  private item(at: number, end: number): number {
    const list = [...this.environments].reverse().find((frame) => LIST_ENVIRONMENTS.has(frame.name));
    if (!list || isLetter(this.text.charCodeAt(end))) return end;
    list.items += 1;
    const depth = this.environments.filter((frame) => LIST_ENVIRONMENTS.has(frame.name)).length;
    const option = this.group(this.spaces(end), "[", "]");
    const stop = option ? option.end : end;
    // The space after `\item` belongs to the marker, so the text starts where the marker ends.
    const markerEnd = this.text[stop] === " " ? stop + 1 : stop;
    this.push(at, markerEnd, {
      kind: "item", list: list.name as ListKind, depth, index: list.items,
      term: option ? this.span(this.spaces(end) + 1, option.end - 1) : null,
    });
    return markerEnd;
  }

  private environment(at: number, end: number, begin: boolean): number {
    const { text } = this;
    const brace = this.spaces(end);
    const group = this.group(brace);
    if (!group || /[{}\\\n]/.test(group.inner)) return end;
    const name = group.inner.trim();
    if (!begin) {
      this.endEnvironment(at, group.end, name);
      return group.end;
    }
    if (SOURCE_ENVIRONMENTS.has(name)) {
      // Nothing in it is read as text; one that does not end in the text keeps the rest as source.
      // A table may hold tables (`\begin{tabular}{@{}c@{}}a\\b\end{tabular}` in a cell); verbatim text holds none.
      const close = TABLE_ENVIRONMENTS.has(name) ? environmentClose(text, name, group.end) : verbatimClose(text, name, group.end);
      if (!close) return text.length;
      // A table outside a float draws as a table; in one, the float draws it.
      if (TABLE_ENVIRONMENTS.has(name) && !this.environments.some((frame) => FIGURE_ENVIRONMENTS.has(frame.name))) {
        this.push(at, close.end, { kind: "block", name });
      }
      return close.end;
    }
    if (DISPLAY_MATH_ENVIRONMENTS.has(name) || name === "math") {
      const closeToken = `\\end{${name}}`;
      const close = text.indexOf(closeToken, group.end);
      // TeX refuses a blank line in math: a block not closed before one is still being typed.
      if (close < 0 || blankLineBetween(text, group.end, close)) return group.end;
      this.push(at, close + closeToken.length, {
        kind: "math", display: name !== "math", body: this.span(group.end, close), environment: name,
      });
      return close + closeToken.length;
    }
    const known = LIST_ENVIRONMENTS.has(name) || FIGURE_ENVIRONMENTS.has(name) || BOXED_ENVIRONMENTS.has(name) || name === "document";
    // An optional argument belongs to the token: `\begin{figure}[t]`, `\begin{theorem}[Fermat]`.
    const option = known ? this.group(this.spaces(group.end), "[", "]") : null;
    const stop = option ? option.end : group.end;
    this.environments.push({ name, items: 0, start: this.constructs.length, at: this.offset + at });
    if (known) {
      const depth = this.environments.filter((frame) => LIST_ENVIRONMENTS.has(frame.name)).length;
      this.push(at, stop, { kind: "environment", name, begin: true, depth, argument: option ? option.inner.trim() : null });
    }
    return stop;
  }

  /** A float that ended: each caption in it takes the first label after it, as LaTeX numbers it. */
  private numberCaptions(start: number) {
    const inside = this.constructs.slice(start).sort((a, b) => a.from - b.from);
    inside.forEach((construct, index) => {
      if (construct.kind !== "caption") return;
      const label = inside.slice(index + 1).find((next) => next.kind === "label" || next.kind === "caption");
      if (label?.kind === "label") construct.label = label.key;
    });
  }

  private endEnvironment(at: number, end: number, name: string) {
    const index = this.environments.map((frame) => frame.name).lastIndexOf(name);
    const depth = this.environments.filter((frame) => LIST_ENVIRONMENTS.has(frame.name)).length;
    if (index >= 0) {
      const { start, at: begin } = this.environments[index];
      if (FIGURE_ENVIRONMENTS.has(name) && start !== undefined) this.numberCaptions(start);
      // The outermost float, begun in this scan, draws as one block.
      const outermost = !this.environments.slice(0, index).some((frame) => FIGURE_ENVIRONMENTS.has(frame.name));
      if (FIGURE_ENVIRONMENTS.has(name) && outermost && begin !== undefined) {
        this.constructs.push({ kind: "block", name, from: begin, to: this.offset + end });
      }
      this.environments.length = index;
    }
    if (LIST_ENVIRONMENTS.has(name) || FIGURE_ENVIRONMENTS.has(name) || BOXED_ENVIRONMENTS.has(name) || name === "document") {
      this.push(at, end, { kind: "environment", name, begin: false, depth, argument: null });
    }
  }
}

/**
 * Whether the `{` at `at` opens a group of its own, not the argument of a
 * command (`\todo{`, `]{`, `}{`): one that starts its line always does.
 */
function bareGroupAt(text: string, at: number): boolean {
  let before = at - 1;
  while (text[before] === " " || text[before] === "\t") before--;
  if (before < 0 || text[before] === "\n") return true;
  const char = text[before];
  if (char === "]" || char === "}") return false;
  if (char === "*") before--;
  let start = before;
  while (start >= 0 && isLetter(text.charCodeAt(start))) start--;
  return start === before || text[start] !== "\\";
}

/**
 * The `\end{name}` that closes an environment whose body starts at `from`,
 * the same-named ones begun inside it counted: where it starts and ends; null when it does not close.
 */
export function environmentClose(text: string, name: string, from: number): { close: number; end: number } | null {
  const token = new RegExp(`\\\\(begin|end)\\s*\\{${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "g");
  token.lastIndex = from;
  let depth = 0;
  for (let match = token.exec(text); match; match = token.exec(text)) {
    if (match[1] === "begin") depth++;
    else if (depth-- === 0) return { close: match.index, end: match.index + match[0].length };
  }
  return null;
}

function verbatimClose(text: string, name: string, from: number): { close: number; end: number } | null {
  const closeToken = `\\end{${name}}`;
  const close = text.indexOf(closeToken, from);
  return close < 0 ? null : { close, end: close + closeToken.length };
}

/** Whether the line break at `at` ends a paragraph: only blanks before the next line break. */
function blankLineAt(text: string, at: number): boolean {
  let next = at + 1;
  while (text[next] === " " || text[next] === "\t" || text[next] === "\r") next++;
  return text[next] === "\n";
}

/** Whether a blank line (TeX's paragraph end, which math cannot cross) lies in `text[from, to)`. */
function blankLineBetween(text: string, from: number, to: number): boolean {
  for (let index = text.indexOf("\n", from); index >= 0 && index < to; index = text.indexOf("\n", index + 1)) {
    if (blankLineAt(text, index)) return true;
  }
  return false;
}
