/**
 * Every `\begin{…}` and `\end{…}` in the document, kept current as it is
 * edited, so Visual mode can tell what encloses the lines it draws (a list
 * and its depth, a verbatim block, the preamble) without reading the text
 * above them. Built once when Visual mode starts; an edit rescans only the
 * lines it touched, and CodeMirror's range set maps the rest through it.
 */
import { RangeSet, RangeValue, StateField, type ChangeSet, type EditorState, type Text } from "@codemirror/state";
import type { Preamble } from "./visual-decorations";
import type { Span } from "./visual-scan";
import { DISPLAY_MATH_ENVIRONMENTS, SOURCE_ENVIRONMENTS } from "./visual-symbols";

/** One `\begin{name}` or `\end{name}` token. */
class EnvironmentMark extends RangeValue {
  constructor(readonly name: string, readonly begin: boolean) {
    super();
  }

  eq(other: RangeValue): boolean {
    return other instanceof EnvironmentMark && other.name === this.name && other.begin === this.begin;
  }
}

/** Environment tokens; `commented` and `escaped` weed out the ones TeX never reads. */
const TOKENS = /\\(begin|end)[ \t]*\{([^{}\n]*)\}/g;

/** Whether the backslash at `at` is itself escaped (`\\begin` is a line break before a word). */
function escaped(text: string, at: number): boolean {
  let count = 0;
  while (at - count - 1 >= 0 && text.charCodeAt(at - count - 1) === 92) count++;
  return count % 2 === 1;
}

/** Whether `at` is inside a comment: an unescaped `%` earlier on its line. */
function commented(text: string, at: number): boolean {
  for (let index = text.lastIndexOf("%", at - 1), start = text.lastIndexOf("\n", at - 1); index > start; index = text.lastIndexOf("%", index - 1)) {
    if (!escaped(text, index)) return true;
  }
  return false;
}

/** The environment tokens of `text`, which starts at `offset` in the document, sorted by position. */
function scanMarks(text: string, offset: number): { from: number; to: number; value: EnvironmentMark }[] {
  const marks: { from: number; to: number; value: EnvironmentMark }[] = [];
  const tokens = new RegExp(TOKENS.source, "g");
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const name = match[2].trim();
    if (!name || escaped(text, match.index) || commented(text, match.index)) continue;
    marks.push({ from: offset + match.index, to: offset + match.index + match[0].length, value: new EnvironmentMark(name, match[1] === "begin") });
  }
  return marks;
}

function buildMarks(doc: Text): RangeSet<EnvironmentMark> {
  return RangeSet.of(scanMarks(doc.toString(), 0).map(({ from, to, value }) => value.range(from, to)));
}

/** The lines `changes` touched, in the new document, merged: what an edit makes the index read again. */
function touchedLines(changes: ChangeSet, doc: Text): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const from = doc.lineAt(fromB).from;
    const to = doc.lineAt(toB).to;
    const last = ranges.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  return ranges;
}

export const environmentIndex = StateField.define<RangeSet<EnvironmentMark>>({
  create: (state) => buildMarks(state.doc),
  update(marks, transaction) {
    if (!transaction.docChanged) return marks;
    let next = marks.map(transaction.changes);
    for (const { from, to } of touchedLines(transaction.changes, transaction.state.doc)) {
      const add = scanMarks(transaction.state.doc.sliceString(from, to), from).map((mark) => mark.value.range(mark.from, mark.to));
      // Every token that now overlaps the touched lines goes; what they hold now comes back in.
      next = next.update({ filterFrom: from, filterTo: to, filter: (markFrom, markTo) => markTo < from || markFrom > to, add });
    }
    return next;
  },
});

/** An environment open at some position: its name and where its `\begin` starts and ends. */
export type OpenEnvironment = { name: string; from: number; to: number };

/**
 * The environments open at `position`, outermost first. Inside a verbatim,
 * listing or other source-only environment the tokens are its text, not
 * environments, so nothing in it opens or closes anything until its own end.
 * A stray `\end` closes the nearest open environment of its name, if any.
 */
export function openEnvironments(state: EditorState, position: number): OpenEnvironment[] {
  const stack: OpenEnvironment[] = [];
  state.field(environmentIndex).between(0, position, (from, to, mark) => {
    if (to > position) return;
    const top = stack.at(-1);
    const literal = top && (SOURCE_ENVIRONMENTS.has(top.name) || DISPLAY_MATH_ENVIRONMENTS.has(top.name));
    if (literal && !(top.name === mark.name && !mark.begin)) return;
    if (mark.begin) {
      stack.push({ name: mark.name, from, to });
      return;
    }
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index].name !== mark.name) continue;
      stack.length = index;
      break;
    }
  });
  return stack;
}

/** Where the environment `open` (from `openEnvironments`) ends: past its `\end{…}`, looked for up to `reach` after it; null when it does not end there. */
export function environmentEnd(state: EditorState, open: OpenEnvironment, reach: number): number | null {
  let depth = 0;
  let end: number | null = null;
  state.field(environmentIndex).between(open.to, Math.min(state.doc.length, open.to + reach), (from, to, mark) => {
    if (from < open.to || mark.name !== open.name) return;
    if (mark.begin) depth++;
    else if (depth-- === 0) {
      end = to;
      return false;
    }
  });
  return end;
}

/** The `\begin{document}` and `\end{document}` tokens, if the file has them (a chapter does not). */
export type DocumentBounds = { begin: { from: number; to: number } | null; end: { from: number; to: number } | null };

const boundsCache = new WeakMap<RangeSet<EnvironmentMark>, DocumentBounds>();
/** How far from the end `\end{document}` is looked for: what follows it is rarely more than a few lines. */
const END_REACH = 20_000;

/** The document's first `\begin{document}` and the `\end{document}` after it; read once per version of the index. */
export function documentBounds(state: EditorState): DocumentBounds {
  const marks = state.field(environmentIndex);
  const cached = boundsCache.get(marks);
  if (cached) return cached;
  const bounds: DocumentBounds = { begin: null, end: null };
  // The body starts near the top and ends near the bottom: neither walk reads the whole index.
  marks.between(0, state.doc.length, (from, to, mark) => {
    if (mark.name !== "document" || !mark.begin) return;
    bounds.begin = { from, to };
    return false;
  });
  if (bounds.begin) {
    marks.between(Math.max(bounds.begin.to, state.doc.length - END_REACH), state.doc.length, (from, to, mark) => {
      if (mark.name === "document" && !mark.begin) bounds.end = { from, to };
    });
  }
  boundsCache.set(marks, bounds);
  return bounds;
}

/** The preamble Visual mode folds away, when `\begin{document}` ends its line. */
export function preambleOf(state: EditorState): Preamble {
  const { begin } = documentBounds(state);
  if (!begin) return null;
  const line = state.doc.lineAt(begin.to);
  return line.text.slice(begin.to - line.from).trim() ? null : { to: line.to };
}

/** `\end{document}`'s line, when the token is alone on it. */
export function endDocumentOf(state: EditorState): Span | null {
  const { end } = documentBounds(state);
  if (!end) return null;
  const line = state.doc.lineAt(end.from);
  return line.text.trim() === state.sliceDoc(end.from, end.to).trim() ? { from: line.from, to: line.to } : null;
}
