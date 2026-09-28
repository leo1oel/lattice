/* eslint-disable lingui/no-unlocalized-strings -- tokenizer: LaTeX command/environment names and CodeMirror style names, none shown as interface text */
/**
 * LaTeX language support: the MIT `stex` stream mode from
 * `@codemirror/legacy-modes`, refined so its tokens carry the highlight tags
 * the editor's style sheet paints, plus folding from a text scan.
 *
 * `stex` styles every control sequence alike and knows nothing about display
 * math environments or verbatim bodies, so the wrapper below classifies the
 * command it just read (sectioning, labels, citations, font commands), runs a
 * math-mode `stex` inside equation-like environments, and gives verbatim
 * bodies, `\verb`, file paths and URLs literal styles. Nothing here depends on
 * a Lezer tree: folding, environment matching and completion all scan text.
 */
import { foldService, LanguageSupport, StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";
import { stex, stexMath } from "@codemirror/legacy-modes/mode/stex";
import type { EditorState, Line } from "@codemirror/state";

type StexState = { cmdState: unknown[]; f: unknown };
type LatexStreamState = {
  /** `stex` in text mode; it also tracks `$…$`, `\(…\)` and `\[…\]` itself. */
  text: StexState;
  /** A math-mode `stex` while inside a display-math environment. */
  math: StexState | null;
  /** `\end{name}` that closes the display-math environment. */
  mathEnd: string | null;
  /** The closing delimiter of the inline math span the text-mode `stex` is in. */
  inlineMath: string | null;
  /** The last control sequence read, without its backslash. */
  command: string;
  /** The token before this one was `\left` or `\right`, so this one is its delimiter. */
  afterSizedDelimiter: boolean;
  /** A verbatim or math environment name read after `\begin{`, waiting for its `}`. */
  pendingEnvironment: string | null;
  /** `\end{name}` that closes the verbatim body this state is inside. */
  verbatimEnd: string | null;
  /** `\verb` or `\lstinline` was just read; its delimited argument comes next. */
  inlineVerbatim: boolean;
  /** How the next braced argument's content is styled (a path or URL, or plain text in math). */
  argumentStyle: string | null;
  /** Where the braced argument stands: before it (possibly in `[…]` options) or just inside it. */
  argument: "before" | "options" | "inside" | null;
};

const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "Verbatim", "boxedverbatim", "lstlisting", "minted", "comment"]);
const MATH_ENVIRONMENTS = new Set(["equation", "align", "gather", "multline", "eqnarray", "displaymath", "math",
  "alignat", "flalign"].flatMap((name) => [name, `${name}*`]));
const INLINE_VERBATIM_COMMANDS = new Set(["verb", "lstinline"]);
/** Commands whose braced argument is a path or URL. */
const PATH_COMMANDS = new Set(["input", "include", "subfile", "includegraphics", "includesvg", "url", "href"]);
/** Commands whose braced argument is text, even in math mode. */
const TEXT_ARGUMENT_COMMANDS = new Set(["text", "textrm", "textit", "textbf", "textsf", "texttt", "textnormal",
  "intertext", "label"]);
/** Structural commands drawn as plain text, like the prose around them. */
const PLAIN_COMMANDS = new Set(["item", "centering", "hline", "toprule", "midrule", "bottomrule", "multicolumn",
  "parbox", "setlength", "footnote", "endnote", "newcommand", "renewcommand", "newenvironment", "renewenvironment",
  "def", "let", "newtheorem", "theoremstyle", "input", "include", "subfile", "includegraphics", "includesvg", "caption",
  "textcolor", "colorbox", "hbox", "url", "href", "verb", "lstinline", "affil", "affiliation", "maketitle", "textsf",
  "textmd", "textrm", "textsuperscript", "textsubscript", "sout", "nocite", "nameref", "newline", "noindent", "left",
  "right", "text"]);
const COMMAND_STYLES = new Map<string, string>([
  ...["book", "part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "title",
    "author", "date", "bibliography", "bibliographystyle"].map((name) => [name, "heading"] as const),
  ...["label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "vref"].map((name) => [name, "labelName"] as const),
  ...["cite", "Cite", "citep", "citet", "citealp", "citealt", "citeauthor", "citeyear", "parencite", "textcite",
    "autocite", "footcite"].map((name) => [name, "quote"] as const),
  ["documentclass", "definitionKeyword"],
  ["textbf", "strong"],
  ["textit", "emphasis"],
  ["emph", "emphasis"],
  ["underline", "emphasis"],
  ["texttt", "monospace"],
  ["textsc", "className"],
]);
/** Math-mode characters drawn as operators; other symbols read as part of the formula. */
const MATH_OPERATORS = "+-=<>/*()~&^_";
const INLINE_MATH_CLOSERS: Record<string, string> = { $: "$", $$: "$$", "\\(": "\\)", "\\[": "\\]" };

const textMode = stex as StreamParser<StexState>;
const mathMode = stexMath as StreamParser<StexState>;

function commandStyle(name: string, state: LatexStreamState, inMath: boolean): string | null {
  state.command = name;
  state.afterSizedDelimiter = name === "left" || name === "right";
  if (INLINE_VERBATIM_COMMANDS.has(name)) state.inlineVerbatim = true;
  const argumentStyle = PATH_COMMANDS.has(name) ? "string" : inMath && TEXT_ARGUMENT_COMMANDS.has(name) ? "" : null;
  if (argumentStyle !== null) {
    state.argumentStyle = argumentStyle || null;
    state.argument = "before";
  }
  return PLAIN_COMMANDS.has(name) ? null : COMMAND_STYLES.get(name) ?? "keyword";
}

/** The style for a token `stex` read, and the bookkeeping it implies. */
function refineStyle(style: string | null, text: string, state: LatexStreamState, inMath: boolean): string | null {
  const sizedDelimiter = state.afterSizedDelimiter;
  state.afterSizedDelimiter = false;
  if (/^\\[A-Za-z@\u00c0-\uffff]/.test(text)) return commandStyle(text.slice(1), state, inMath);
  // Control symbols: `\\` is a plain line break, `\%`, `\,` and the like are operators.
  if (text.startsWith("\\") && style !== "keyword") return text === "\\\\" || text === "\\" ? null : "operator";
  if (style === "keyword") {
    // Math delimiters: `stex` switches modes itself, this only mirrors it.
    state.inlineMath = state.inlineMath === text ? null : state.inlineMath ?? INLINE_MATH_CLOSERS[text] ?? null;
    return text.startsWith("$") ? "processingInstruction" : null;
  }
  if (text === "&" || text === "~") return "operator";
  if (style === "atom") {
    // `stex` marks the arguments of \begin, \end, \label, \cite, … and numbers as atoms;
    // only environment names get a style of their own.
    if (/^\d/.test(text) || (state.command !== "begin" && state.command !== "end")) return null;
    if (state.command === "begin" && (VERBATIM_ENVIRONMENTS.has(text) || MATH_ENVIRONMENTS.has(text))) {
      state.pendingEnvironment = text;
    }
    return "className";
  }
  if (style === "comment" || style === "bracket" && "{}[]".includes(text)) return style;
  if (!inMath) return style === "error" ? null : style;
  if (sizedDelimiter) return null;
  if (style === "number") return style;
  if (text.length === 1 && MATH_OPERATORS.includes(text)) return "operator";
  return text.trim() ? "variableName" : null;
}

/** Advance up to the next `close` on this line (or its end). */
function readLiteral(stream: StringStream, close: string): void {
  const end = stream.string.indexOf(close, stream.pos);
  stream.pos = end < 0 ? stream.string.length : end;
}

/** Track the braced argument a path, URL or text command is waiting for. */
function trackArgument(state: LatexStreamState, style: string | null, text: string): void {
  if (!state.argument) return;
  if (style === "bracket" && text === "[") state.argument = "options";
  else if (style === "bracket" && text === "]" && state.argument === "options") state.argument = "before";
  else if (style === "bracket" && text === "{" && state.argument === "before") state.argument = "inside";
  else if (state.argument === "before" && text.trim() && !/^\\[A-Za-z@]/.test(text)) state.argument = null;
}

function enterEnvironment(state: LatexStreamState): void {
  const name = state.pendingEnvironment;
  state.pendingEnvironment = null;
  if (!name) return;
  if (VERBATIM_ENVIRONMENTS.has(name)) state.verbatimEnd = `\\end{${name}}`;
  else {
    state.math = mathMode.startState!(2);
    state.mathEnd = `\\end{${name}}`;
  }
}

const latexStreamParser: StreamParser<LatexStreamState> = {
  name: "latex",
  startState: (indentUnit) => ({
    text: textMode.startState!(indentUnit),
    math: null,
    mathEnd: null,
    inlineMath: null,
    command: "",
    afterSizedDelimiter: false,
    pendingEnvironment: null,
    verbatimEnd: null,
    inlineVerbatim: false,
    argumentStyle: null,
    argument: null,
  }),
  copyState: (state) => ({
    ...state,
    text: textMode.copyState!(state.text),
    math: state.math && mathMode.copyState!(state.math),
  }),
  blankLine(state, indentUnit) {
    if (state.verbatimEnd) return;
    textMode.blankLine!(state.text, indentUnit);
    state.inlineMath = null;
  },
  token(stream, state) {
    if (state.verbatimEnd) {
      if (!stream.match(state.verbatimEnd, false)) {
        readLiteral(stream, state.verbatimEnd);
        return "meta";
      }
      state.verbatimEnd = null;
    }
    if (state.inlineVerbatim) {
      state.inlineVerbatim = false;
      stream.eat("*");
      const open = stream.next();
      if (!open || /\s/.test(open)) return null;
      const close = open === "{" ? "}" : open;
      readLiteral(stream, close);
      stream.eat(close);
      return "meta";
    }
    if (state.argument === "inside") {
      state.argument = null;
      if (stream.peek() !== "}") {
        readLiteral(stream, "}");
        return state.argumentStyle;
      }
    }
    if (state.mathEnd && stream.match(state.mathEnd, false)) {
      state.math = null;
      state.mathEnd = null;
    }
    if (state.math || state.inlineMath) {
      // Math-mode `stex` reads a `\\` line break as two stray backslashes.
      if (stream.match("\\\\")) return null;
    } else {
      // Text-mode `stex` folds these into the neighbouring word: a tie, an
      // alignment tab, a control space and TeX's `\@` spacing marker.
      if (stream.eat("~") || stream.eat("&") || stream.match("\\ ") || stream.match("\\@")) return "operator";
    }
    const inMath = state.math !== null || state.inlineMath !== null;
    const style = state.math ? mathMode.token(stream, state.math) : textMode.token(stream, state.text);
    // `stex` stops an environment name before a trailing star.
    if (style === "atom" && stream.peek() === "*") stream.next();
    const text = stream.current();
    trackArgument(state, style, text);
    const refined = refineStyle(style, text, state, inMath);
    if (style === "bracket" && text === "}" && state.pendingEnvironment) enterEnvironment(state);
    return refined;
  },
  languageData: {
    commentTokens: { line: "%" },
    wordChars: "$\\-_",
  },
};

export const latexLanguage = StreamLanguage.define(latexStreamParser);

const SECTION_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};
const SECTION = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?![A-Za-z@])/;
/** Where a section's body stops even without a following heading. */
const SECTION_STOP = /^\s*\\(?:end\{document\}|appendix(?![A-Za-z@])|bibliography(?![A-Za-z@])|printbibliography(?![A-Za-z@]))/;
const ENVIRONMENT = /\\(begin|end)\s*\{([^{}]+)\}/g;
const COMMENT_LINE = /^\s*%/;
/**
 * Forward scans from a line give up after this many lines, so a fold gutter
 * over a huge file stays cheap. Brace groups are scanned character by
 * character (and are left open for a moment while typing), so they get less.
 */
const MAX_FOLD_SCAN_LINES = 20_000;
const MAX_GROUP_SCAN_LINES = 1_000;

/** `text` without its `%` comment (an escaped `\%` is text). */
export function uncommented(text: string): string {
  for (let index = text.indexOf("%"); index >= 0; index = text.indexOf("%", index + 1)) {
    let backslashes = 0;
    while (index - backslashes - 1 >= 0 && text[index - backslashes - 1] === "\\") backslashes++;
    if (backslashes % 2 === 0) return text.slice(0, index);
  }
  return text;
}

/** Lines after `line`, stopping at the document end or the scan limit. */
function* linesAfter(state: EditorState, line: Line, limit = MAX_FOLD_SCAN_LINES): Generator<Line> {
  const last = Math.min(state.doc.lines, line.number + limit);
  for (let number = line.number + 1; number <= last; number++) yield state.doc.line(number);
}

/** The last non-blank line from `start` back to (but excluding) `floor`. */
function lastContentLine(state: EditorState, start: Line, floor: Line): Line {
  let line = start;
  while (line.number > floor.number + 1 && !line.text.trim()) line = state.doc.line(line.number - 1);
  return line;
}

/** `\begin{name}` on this line whose `\end{name}` is on a later line: fold between them. */
function environmentFold(state: EditorState, line: Line, text: string) {
  const opened: string[] = [];
  for (const match of text.matchAll(ENVIRONMENT)) {
    if (match[1] === "begin") opened.push(match[2]);
    else if (opened.at(-1) === match[2]) opened.pop();
  }
  const name = opened[0];
  if (!name) return null;
  let depth = opened.filter((open) => open === name).length;
  for (const next of linesAfter(state, line)) {
    if (!next.text.includes("\\begin") && !next.text.includes("\\end")) continue;
    for (const match of uncommented(next.text).matchAll(ENVIRONMENT)) {
      if (match[2] !== name) continue;
      depth += match[1] === "begin" ? 1 : -1;
      if (depth === 0) return { from: line.to, to: next.from + match.index };
    }
  }
  return null;
}

/** A heading folds to the line before the next heading at its level or above. */
function sectionFold(state: EditorState, line: Line, text: string) {
  const level = SECTION_LEVELS[SECTION.exec(text)?.[1] ?? ""];
  if (level === undefined) return null;
  let end = line;
  for (const next of linesAfter(state, line)) {
    if (!next.text.includes("\\")) {
      end = next;
      continue;
    }
    const heading = SECTION.exec(next.text)?.[1];
    if ((heading && SECTION_LEVELS[heading] <= level) || SECTION_STOP.test(next.text)) break;
    end = next;
  }
  end = lastContentLine(state, end, line);
  return end.number > line.number ? { from: line.to, to: end.to } : null;
}

/** The preamble folds from `\documentclass` to the line before `\begin{document}`. */
function preambleFold(state: EditorState, line: Line, text: string) {
  if (!/^\s*\\documentclass(?![A-Za-z@])/.test(text)) return null;
  let end = line;
  for (const next of linesAfter(state, line)) {
    if (/^\s*\\begin\s*\{document\}/.test(next.text)) {
      end = lastContentLine(state, end, line);
      return end.number > line.number ? { from: line.to, to: end.to } : null;
    }
    end = next;
  }
  return null;
}

/** A brace group left open on this line folds to its closing brace. */
function groupFold(state: EditorState, line: Line, text: string) {
  const open: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\") index++;
    else if (character === "{") open.push(index);
    else if (character === "}") open.pop();
  }
  if (!open.length) return null;
  let depth = open.length;
  for (const next of linesAfter(state, line, MAX_GROUP_SCAN_LINES)) {
    const nextText = uncommented(next.text);
    for (let index = 0; index < nextText.length; index++) {
      const character = nextText[index];
      if (character === "\\") index++;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        // The first brace still open on the starting line closes here.
        return { from: line.from + open[0] + 1, to: next.from + index };
      }
    }
  }
  return null;
}

/** A run of two or more comment lines folds to the end of its last line. */
function commentFold(state: EditorState, line: Line) {
  if (!COMMENT_LINE.test(line.text)) return null;
  if (line.number > 1 && COMMENT_LINE.test(state.doc.line(line.number - 1).text)) return null;
  let end = line;
  for (const next of linesAfter(state, line)) {
    if (!COMMENT_LINE.test(next.text)) break;
    end = next;
  }
  return end.number > line.number ? { from: line.to, to: end.to } : null;
}

/**
 * Fold ranges from a text scan: environments, sectioning, the preamble,
 * multi-line brace groups and comment blocks. The fold gutter asks for every
 * visible line on each update, so each branch first rejects lines cheaply.
 */
export function latexFoldRange(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const text = uncommented(line.text);
  return (text.includes("\\begin") ? environmentFold(state, line, text) : null)
    ?? (text.includes("\\") ? sectionFold(state, line, text) ?? preambleFold(state, line, text) : null)
    ?? (text.includes("{") ? groupFold(state, line, text) : null)
    ?? commentFold(state, line);
}

/** LaTeX highlighting, comment tokens and folding for source editors. */
export function latex(): LanguageSupport {
  return new LanguageSupport(latexLanguage, [foldService.of((state, lineStart) => latexFoldRange(state, lineStart))]);
}
