/**
 * The parts of LaTeX source a language edit must leave byte for byte: math,
 * citation/reference/label commands with their keys, % comments, command
 * names with their braces and options, environment boundaries, verbatim code,
 * and paragraph breaks. Everything outside a span is prose an editor may
 * change, including the text inside known prose arguments such as
 * `\emph{…}` and `\caption{…}`; the arguments of a macro this module does
 * not know are protected whole, because nothing says they are prose.
 *
 * The scanner is stateless between spans: starting it at any position that
 * no span covers reads the rest of the source the way a scan from the start
 * would. `proofreadContext` relies on that to check a selection on its own.
 */

export type ProtectedKind = "math" | "reference" | "comment" | "command" | "environment" | "verbatim" | "paragraph";

export type ProtectedSpan = { from: number; to: number; kind: ProtectedKind };

const words = (list: string) => list.trim().split(/\s+/);
const starred = (names: string[]) => names.flatMap((name) => [name, `${name}*`]);

/* eslint-disable lingui/no-unlocalized-strings -- LaTeX command and environment names, not interface copy */
const MATH_ENVIRONMENTS = new Set(starred(words(`
  align alignat displaymath eqnarray equation flalign gather math multline
`)));

const VERBATIM_ENVIRONMENTS = new Set(starred(words(`
  comment listing lstlisting minted verbatim Verbatim
`)));

/** Every argument of these is a key, label, URL or path: the whole command is protected. */
const REFERENCE_COMMANDS = new Set(words(`
  autocite autoref bibliography bibliographystyle cite citealp citealt citeauthor citep citet citeyear cref Cref
  eqref footcite fullcite href hyperref include includegraphics input label nameref nocite pageref parencite ref
  subref textcite url vref
`));

/**
 * Commands whose braced arguments are prose, with how many leading braced
 * arguments are not (a color name, say). Their name, options and braces stay
 * protected; the prose between the braces may be edited.
 */
const PROSE_COMMANDS = new Map<string, number>([
  ...words(`
    caption chapter emph enquote footnote marginpar mbox paragraph part section subparagraph subsection
    subsubsection textbf textit textmd textnormal textrm textsc textsf textsl textup thanks title underline
  `).map((name): [string, number] => [name, 0]),
  ["colorbox", 1], ["textcolor", 1],
]);
/* eslint-enable lingui/no-unlocalized-strings */

const isLetter = (char: string | undefined) => char !== undefined && /[A-Za-z@]/.test(char);
const isSpace = (char: string | undefined) => char === " " || char === "\t";

/** Offset just past the balanced `open`…`close` group starting at `start`; the source end if unclosed. */
function groupEnd(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close && (depth -= 1) === 0) return index + 1;
  }
  return source.length;
}

/** Offset of the blank line ending the paragraph at `from`, or the source end. */
function paragraphEnd(source: string, from: number): number {
  const blank = /\n[^\S\n]*\n/g;
  blank.lastIndex = from;
  return blank.exec(source)?.index ?? source.length;
}

/**
 * Offset just past an unescaped `closer` after `from`. TeX refuses a blank
 * line inside inline or display math, so an unclosed delimiter protects only
 * to the end of its paragraph.
 */
function mathEnd(source: string, from: number, closer: string): number {
  const limit = paragraphEnd(source, from);
  for (let index = from; index < limit; index += 1) {
    if (source.startsWith(closer, index)) return index + closer.length;
    if (source[index] === "\\") index += 1;
  }
  return limit;
}

/** Offset just past the adjacent `[…]` and `{…}` groups at `from`, at most `braced` brace groups. */
function argumentsEnd(source: string, from: number, braced: number, skipSpaces: boolean): number {
  let cursor = from;
  for (let groups = 0; ;) {
    let next = cursor;
    if (skipSpaces) while (isSpace(source[next])) next += 1;
    const char = source[next];
    if (char === "[") cursor = groupEnd(source, next, "[", "]");
    else if (char === "{" && groups < braced) {
      cursor = groupEnd(source, next, "{", "}");
      groups += 1;
    } else return cursor;
  }
}

/** Offset just past `[…]` groups (a command's options) at `from`. */
const optionsEnd = (source: string, from: number) => argumentsEnd(source, from, 0, false);

/**
 * The protected spans of `source`, in order and never overlapping. Spans
 * starting at or after `until` are not collected (one that starts before it
 * is still reported whole).
 */
export function protectedLatexSpans(source: string, until = source.length): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  const add = (from: number, to: number, kind: ProtectedKind) => {
    if (to > from) spans.push({ from, to, kind });
    return Math.max(to, from + 1);
  };
  let index = 0;
  while (index < source.length && index < until) {
    const char = source[index];
    if (char === "%") {
      // An escaped \% never reaches here: the backslash branch consumes it.
      const newline = source.indexOf("\n", index);
      index = add(index, newline < 0 ? source.length : newline, "comment");
    } else if (char === "$") {
      const marker = source[index + 1] === "$" ? "$$" : "$";
      index = add(index, mathEnd(source, index + marker.length, marker), "math");
    } else if (char === "{" || char === "}" || char === "&" || char === "#") {
      index = add(index, index + 1, "command");
    } else if (char === "\n") {
      const blank = /\n[^\S\n]*\n\s*/y;
      blank.lastIndex = index;
      index = blank.test(source) ? add(index, blank.lastIndex, "paragraph") : index + 1;
    } else if (char === "\\") {
      index = command(source, index, add);
    } else {
      index += 1;
    }
  }
  return spans;
}

/** Protect the command, escape or math opener at `start`; the offset to continue from. */
function command(source: string, start: number, add: (from: number, to: number, kind: ProtectedKind) => number): number {
  const next = source[start + 1];
  if (!isLetter(next)) {
    if (next === "(") return add(start, mathEnd(source, start + 2, "\\)"), "math");
    if (next === "[") return add(start, mathEnd(source, start + 2, "\\]"), "math");
    // `\\` takes a spacing option (`\\[2pt]`); any other escape is two characters.
    const end = Math.min(source.length, start + 2);
    return add(start, next === "\\" ? optionsEnd(source, end) : end, "command");
  }
  let cursor = start + 1;
  while (isLetter(source[cursor])) cursor += 1;
  const name = source.slice(start + 1, cursor);
  if (source[cursor] === "*") cursor += 1;

  if (name === "begin" || name === "end") {
    const environmentEnd = source[cursor] === "{" ? groupEnd(source, cursor, "{", "}") : cursor;
    const environment = source.slice(cursor + 1, environmentEnd - 1);
    if (name === "begin" && (MATH_ENVIRONMENTS.has(environment) || VERBATIM_ENVIRONMENTS.has(environment))) {
      const close = source.indexOf(`\\end{${environment}}`, environmentEnd);
      const end = close < 0 ? source.length : close + `\\end{${environment}}`.length;
      return add(start, end, MATH_ENVIRONMENTS.has(environment) ? "math" : "verbatim");
    }
    // `\begin{tabular}{ll}`, `\begin{figure}[t]`: the arguments configure the environment.
    const end = name === "begin" ? argumentsEnd(source, environmentEnd, Number.POSITIVE_INFINITY, false) : environmentEnd;
    return add(start, end, "environment");
  }
  if (name === "verb") {
    const delimiter = source[cursor];
    const close = delimiter ? source.indexOf(delimiter, cursor + 1) : -1;
    const lineEnd = source.indexOf("\n", cursor);
    const end = close < 0 || (lineEnd >= 0 && close > lineEnd) ? cursor + 1 : close + 1;
    return add(start, end, "verbatim");
  }
  if (REFERENCE_COMMANDS.has(name)) {
    return add(start, argumentsEnd(source, cursor, Number.POSITIVE_INFINITY, true), "reference");
  }
  const leading = PROSE_COMMANDS.get(name);
  if (leading !== undefined) {
    // The prose argument's braces are protected one by one by the main scan.
    return add(start, argumentsEnd(source, cursor, leading, false), "command");
  }
  return add(start, argumentsEnd(source, cursor, Number.POSITIVE_INFINITY, false), "command");
}

/** One protected span as it compares across edits: a paragraph break is any blank-line run. */
type SignatureEntry = { kind: ProtectedKind; key: string };

export function protectedLatexSignature(source: string): SignatureEntry[] {
  return protectedLatexSpans(source).map(({ from, to, kind }) => ({
    kind,
    key: kind === "paragraph" ? kind : `${kind}:${source.slice(from, to)}`,
  }));
}

/**
 * The kind of protected LaTeX that differs between two signatures, or null
 * when every protected span survived unchanged and in order.
 */
export function protectedDifference(before: SignatureEntry[], after: SignatureEntry[]): ProtectedKind | null {
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (left?.key === right?.key) continue;
    // A span the edit added names the change better than the one it shifted.
    return (after.length > before.length ? right ?? left : left ?? right)!.kind;
  }
  return null;
}
