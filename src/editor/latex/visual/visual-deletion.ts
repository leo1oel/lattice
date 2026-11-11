/** Deleting in Visual mode, as the writer sees the text drawn: the rules are under `visualDeletion`. */
import { EditorSelection, EditorState, Prec, findClusterBreak, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Command, type DecorationSet } from "@codemirror/view";
import { endDocumentOf, preambleOf } from "./visual-environments";
import type { Construct, Span } from "./visual-scan";

/** What Visual mode has scanned and drawn, as deletion reads it. */
type DrawnState = { constructs: readonly Construct[]; replacements: DecorationSet };
type ReadDrawn = (state: EditorState) => DrawnState | undefined;

/** The keys that delete as drawn, and the filter that never orphans a token. */
export function visualDeletion(read: ReadDrawn): Extension {
  return [
    Prec.highest(keymap.of([
      { key: "Backspace", run: deleteAcrossTokens(read, false), shift: deleteAcrossTokens(read, false) },
      { key: "Delete", run: deleteAcrossTokens(read, true) },
      /* eslint-disable lingui/no-unlocalized-strings -- CodeMirror key names, never shown */
      { mac: "Ctrl-h", run: deleteAcrossTokens(read, false) },
      { mac: "Ctrl-d", run: deleteAcrossTokens(read, true) },
      { mac: "Alt-Backspace", run: deleteVisible(read, "group", false), preventDefault: true },
      { mac: "Alt-Delete", run: deleteVisible(read, "group", true), preventDefault: true },
      { mac: "Ctrl-Alt-h", run: deleteVisible(read, "group", false) },
      { mac: "Mod-Backspace", run: deleteVisible(read, "wrap", false), preventDefault: true },
      { mac: "Mod-Delete", run: deleteVisible(read, "wrap", true), preventDefault: true },
      { mac: "Ctrl-k", run: deleteVisible(read, "line", true) },
      /* eslint-enable lingui/no-unlocalized-strings */
    ])),
    unwrapOnDelete(read),
  ];
}

/*
 * Deleting in Visual mode. A single-character deletion (Backspace, Delete,
 * Ctrl-h, Ctrl-d) works as in a word processor:
 * - It never deletes a token Visual mode draws, hidden or as a faint brace
 *   (`\textbf{`, `}`, `\href{url}{`, `{\bf `, a term's `\item[` and `]`), nor
 *   a heading's or caption's, drawn or not. It steps over them, deletes the
 *   character beyond (a widget beyond them goes whole), and the caret stays
 *   on its side of them.
 * - Leaving a description term over its bracket removes the item's marker
 *   instead, as Backspace at an itemize item removes its bullet; the term
 *   keeps its line.
 * - It never deletes a line break a drawn block stands on: the folded
 *   preamble's or the end-of-document bar's, or one that would join a line
 *   of text onto an environment's or a display's (a blank line next to one
 *   still goes).
 * - With the caret just outside a construct whose content is empty, it
 *   removes the construct; inside one, the deletion is Source's.
 * - Past the start or end of the document it deletes nothing.
 * A word or line deletion from the caret (Option- or Cmd-Backspace and
 * -Delete, Ctrl-Alt-h, Ctrl-k) reads the line as drawn: the word or line
 * part it deletes is found in the text without the tokens, only that text
 * goes, and a construct whose content all goes goes whole.
 * Any other edit that removes one token of a pair but not the other removes
 * both, unless the text put in its place brings the token's bracket back
 * (`\subsection{` over `\section{`). Each is one edit, undone at once, and no
 * brace or bracket is ever left unbalanced.
 */

/**
 * A construct drawn between an opening and a closing token. `always`: its
 * tokens are stepped over even while its source shows (a heading's or
 * caption's with a title). `term`: a description item's `[…]`.
 */
type TokenPair = { from: number; to: number; open: Span; close: Span; brackets: string; always: boolean; term: boolean };

function tokenPairs(value: DrawnState): TokenPair[] {
  const pairs: TokenPair[] = [];
  for (const construct of value.constructs) {
    const { from, to } = construct;
    if (construct.kind === "style" || construct.kind === "link") {
      pairs.push({ from, to, open: construct.open, close: construct.close, brackets: "{}", always: false, term: false });
    } else if (construct.kind === "heading" || construct.kind === "caption") {
      const always = construct.open.to < construct.close.from;
      pairs.push({ from, to, open: construct.open, close: construct.close, brackets: "{}", always, term: false });
    } else if (construct.kind === "item" && construct.term) {
      const close = { from: construct.term.to, to: construct.term.to + 1 };
      pairs.push({ from, to: close.to, open: { from, to: construct.term.from }, close, brackets: "[]", always: false, term: true });
    }
  }
  return pairs;
}

/** How many more of `brackets`' opening character than its closing one `text` has. */
function bracketBalance(text: string, brackets: string): number {
  let balance = 0;
  for (const char of text) balance += char === brackets[0] ? 1 : char === brackets[1] ? -1 : 0;
  return balance;
}

/** The hidden range a token is drawn as: a replacement holding it and sharing one of its edges. */
function drawnRange(value: DrawnState, token: Span): Span | null {
  let range: Span | null = null;
  value.replacements.between(token.from, token.to, (from, to) => {
    if (from > token.from || to < token.to || (from !== token.from && to !== token.to)) return;
    range = { from, to };
    return false;
  });
  return range;
}

/** The tokens a deletion steps over, as the ranges they are drawn as (a heading's or caption's even when not drawn). */
function steppedTokens(value: DrawnState, pairs: readonly TokenPair[]) {
  return pairs.flatMap((pair) => (["open", "close"] as const).flatMap((side) => {
    const span = drawnRange(value, pair[side]) ?? (pair.always ? pair[side] : null);
    return span ? [{ span, pair, side }] : [];
  }));
}

/** Removes `ranges` from the caret's deletion; the caret keeps its place in the text before or after them. */
function removeRanges(view: EditorView, forward: boolean, ranges: readonly Span[]): true {
  const changes = view.state.changes([...ranges]);
  const anchor = changes.mapPos(view.state.selection.main.head);
  view.dispatch({ changes, selection: { anchor }, scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward" });
  return true;
}

function deleteAcrossTokens(read: ReadDrawn, forward: boolean): Command {
  return (view) => {
    const { state } = view;
    const value = read(state);
    const { main } = state.selection;
    if (!value || state.selection.ranges.length > 1 || !main.empty) return false;
    const pairs = tokenPairs(value);
    const drawn = (token: Span) => drawnRange(value, token);
    const steps = steppedTokens(value, pairs);
    const remove = (...ranges: Span[]) => removeRanges(view, forward, ranges);
    let at = main.head;
    let stepped = false;
    for (;;) {
      const empty = pairs.find((pair) => pair.open.to === pair.close.from && at === (forward ? pair.from : pair.to));
      if (empty) return remove({ from: empty.from, to: empty.to });
      const step = steps.find(({ span }) => (forward ? span.from : span.to) === at);
      if (!step) break;
      if (step.pair.term && step.side === (forward ? "close" : "open")) return remove(drawn(step.pair.open) ?? step.pair.open, step.pair.close);
      at = forward ? step.span.to : step.span.from;
      stepped = true;
    }
    if (forward ? at >= state.doc.length : at <= 0) return stepped;
    const line = state.doc.lineAt(at);
    const lineBreak = forward ? at === line.to : at === line.from;
    let from = forward ? at : lineBreak ? at - 1 : line.from + findClusterBreak(line.text, at - line.from, false);
    let to = !forward ? at : lineBreak ? at + 1 : line.from + findClusterBreak(line.text, at - line.from, true);
    const blank = !line.text.trim();
    let blockEdge = false;
    value.replacements.between(from, to, (rangeFrom, rangeTo, decoration) => {
      if (!lineBreak || !decoration.spec.block || rangeFrom >= rangeTo || (rangeTo !== from && rangeFrom !== to)) return;
      blockEdge = !blank || rangeTo === preambleOf(state)?.to || rangeFrom === endDocumentOf(state)?.from;
      if (blockEdge) return false;
    });
    if (blockEdge) return true;
    if (!stepped) return false;
    value.replacements.between(from, to, (rangeFrom, rangeTo) => {
      if (rangeFrom < to && rangeTo > from) {
        from = Math.min(from, rangeFrom);
        to = Math.max(to, rangeTo);
      }
    });
    return remove({ from, to });
  };
}

/** A word (`group`), or the rest of the line as wrapped on screen (`wrap`) or in the text (`line`), deleted from the caret. */
function deleteVisible(read: ReadDrawn, unit: "group" | "wrap" | "line", forward: boolean): Command {
  const byCharacter = deleteAcrossTokens(read, forward);
  return (view) => {
    const { state } = view;
    const value = read(state);
    const { main } = state.selection;
    if (!value || state.selection.ranges.length > 1 || !main.empty) return false;
    const pairs = tokenPairs(value);
    const steps = steppedTokens(value, pairs).filter(({ pair, side, span }) => drawnRange(value, pair[side]) || span.from >= main.head || span.to <= main.head);
    const hidden = steps.map(({ span }) => span);
    const symbols = new Map<number, Construct>();
    for (const construct of value.constructs) if (construct.kind === "symbol") symbols.set(construct.from, construct);
    const line = view.lineBlockAt(main.head);
    const text = state.sliceDoc(line.from, line.to);
    const widgets: Span[] = [];
    value.replacements.between(line.from, line.to, (from, to) => {
      if (from < to) widgets.push({ from, to });
    });
    // The line as drawn (a widget over a line break joins two): each character, a widget as one (a symbol as what it
    // prints, which may be nothing), the hidden tokens left out.
    const units: { from: number; to: number; text: string }[] = [];
    for (let pos = line.from; pos < line.to;) {
      const token = hidden.find(({ from, to }) => from <= pos && to > pos);
      if (token) {
        pos = token.to;
        continue;
      }
      const widget = widgets.find(({ from, to }) => from <= pos && to > pos);
      const unit = widget ?? { from: pos, to: line.from + findClusterBreak(text, pos - line.from, true) };
      const symbol = widget && symbols.get(widget.from);
      const drawn = symbol && symbol.kind === "symbol" && symbol.to === widget.to ? symbol.text : "\uFFFC";
      units.push({ ...unit, text: widget ? drawn : state.sliceDoc(unit.from, unit.to) });
      pos = unit.to;
    }
    const caret = units.filter(({ to }) => to <= main.head).length;
    let gone: typeof units;
    if (unit === "group") {
      const categorize = state.charCategorizer(main.head);
      const first = forward ? caret : caret - 1;
      let end = caret;
      let category: ReturnType<typeof categorize> | null = null;
      for (let index = first; index >= 0 && index < units.length; index += forward ? 1 : -1) {
        if (!units[index].text) {
          end = forward ? index + 1 : index;
          continue;
        }
        const next = categorize(units[index].text);
        if (category !== null && next !== category) break;
        if (units[index].text !== " " || index !== first) category = next;
        end = forward ? index + 1 : index;
      }
      gone = forward ? units.slice(caret, end) : units.slice(end, caret);
    } else {
      const boundary = unit === "wrap" ? view.moveToLineBoundary(EditorSelection.cursor(main.head), forward).head : forward ? line.to : line.from;
      gone = units.filter(({ from, to }) => (forward ? from >= main.head && to <= boundary : to <= main.head && from >= boundary));
    }
    if (!gone.length) return byCharacter(view);
    let ranges: Span[] = gone.map(({ from, to }) => ({ from, to }));
    for (const pair of pairs) {
      const tokens = steps.filter((step) => step.pair === pair);
      if (!tokens.length || pair.open.from < line.from || pair.close.to > line.to) continue;
      const content = units.filter(({ from, to }) => from >= pair.open.to && to <= pair.close.from);
      if (content.length && content.every((item) => gone.includes(item))) ranges.push(...tokens.map(({ span }) => span));
    }
    const covered = (at: number) => ranges.some(({ from, to }) => from <= at && to > at);
    for (const pair of pairs) {
      const open = pair.open.from + state.sliceDoc(pair.open.from, pair.open.to).lastIndexOf(pair.brackets[0]);
      const close = pair.close.from;
      if (covered(open) === covered(close)) continue;
      const kept = covered(open) ? open : close;
      ranges = ranges.flatMap(({ from, to }) => (from <= kept && to > kept ? [{ from, to: kept }, { from: kept + 1, to }] : [{ from, to }]))
        .filter(({ from, to }) => from < to);
    }
    if (!ranges.length) return true;
    return removeRanges(view, forward, ranges.sort((a, b) => a.from - b.from));
  };
}

function unwrapOnDelete(read: ReadDrawn): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !(transaction.isUserEvent("delete") || transaction.isUserEvent("input"))) return transaction;
    const value = read(transaction.startState);
    if (!value) return transaction;
    const edits: { from: number; to: number; inserted: string }[] = [];
    transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      if (from < to) edits.push({ from, to, inserted: inserted.toString() });
    });
    const covering = (span: Span) => edits.find(({ from, to }) => from <= span.from && to >= span.to);
    const reaches = (span: Span) => edits.some(({ from, to }) => from < span.to && to > span.from);
    const orphaned: Span[] = [];
    for (const { open, close, brackets } of tokenPairs(value)) {
      const opening = !reaches(close) && covering(open);
      const closing = !reaches(open) && covering(close);
      if (opening && bracketBalance(opening.inserted, brackets) <= 0) orphaned.push(close);
      else if (closing && bracketBalance(closing.inserted, brackets) >= 0) orphaned.push(open);
    }
    if (!orphaned.length) return transaction;
    const changes = orphaned.map(({ from, to }) => ({ from: transaction.changes.mapPos(from), to: transaction.changes.mapPos(to) }));
    return [transaction, { changes, sequential: true }];
  });
}
