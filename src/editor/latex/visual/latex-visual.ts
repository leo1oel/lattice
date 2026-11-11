/**
 * Visual mode for a .tex file: the same CodeMirror editor and the same LaTeX
 * text, drawn with its headings, emphasis, math, lists, figures, references
 * and citations rendered in place. Every edit is an ordinary text edit; the
 * caret entering a rendered construct shows its source for editing.
 *
 * The behaviour follows Overleaf's Visual Editor as described in a clean-room
 * study (no Overleaf code was read or copied for this module; see the pull
 * request that added it). The structure is Lattice's own:
 *
 * - A state field scans only a window around the viewport (a ViewPlugin
 *   moves the window as the writer scrolls) and keeps the constructs found.
 *   Replacements that span lines or draw blocks (display math, figures) can
 *   only come from a field, which is why the window is pushed into it
 *   rather than read from the view.
 * - Moving the caret only decides which constructs show their source;
 *   nothing is scanned again unless the text or the window changed.
 * - While the pointer is down the reveal is frozen, so constructs neither
 *   open nor close under a press or a drag; the release settles it.
 */
import { EditorSelection, EditorState, Prec, StateEffect, StateField, findClusterBreak, type ChangeSet, type Extension, type RangeSet, type RangeValue } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type Command, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { compiledLabels, type CompiledBuild, type CompiledLabel } from "../compiled-labels";
import { latexVisualDataChanged, type LatexVisualHost } from "../latex-visual-switch";
import { isPointerRelease, pointerSelection } from "../../pointer-selection";
import { overlaysTouch, sourceOverlays } from "../../source-overlays";
import { buildReplacements, buildStyles, revealedConstructs, selectionPoints, type Preamble } from "./visual-decorations";
import { documentBounds, environmentIndex, openEnvironments } from "./visual-environments";
import { scanConstructs, type Construct, type ScanFrame, type Span } from "./visual-scan";
import { DISPLAY_MATH_ENVIRONMENTS, LIST_ENVIRONMENTS, SOURCE_ENVIRONMENTS } from "./visual-symbols";
import "./latex-visual.css";

/** The lines Visual mode draws, around the viewport. */
const setWindow = StateEffect.define<Span>();
/** A primary press began in the editor: hold the reveal until it ends. */
const pointerPressed = StateEffect.define<null>();

/** Lines scanned beyond each end of the viewport (which CodeMirror already draws with a margin). */
const WINDOW_MARGIN_LINES = 60;
/** How far back a scan may start to read a list's items from its top, or a paragraph from its start. */
const LIST_REACH = 120_000;
const PARAGRAPH_REACH_LINES = 80;

type VisualState = {
  window: Span | null;
  /** Where the scan starts, and what is open there; kept while edits land after it. */
  context: { start: number; frames: ScanFrame[] } | null;
  constructs: Construct[];
  /** The pre-press selection while the pointer is down, mapped through edits. */
  frozen: EditorSelection | null;
  overlays: readonly RangeSet<RangeValue>[];
  revealed: string;
  replacements: DecorationSet;
  styles: DecorationSet;
};

/** The start of the paragraph holding `position`: past the nearest blank line above, looking back a bounded way. */
function paragraphStart(state: EditorState, position: number): number {
  let line = state.doc.lineAt(position);
  for (let steps = 0; steps < PARAGRAPH_REACH_LINES && line.number > 1; steps++) {
    const previous = state.doc.line(line.number - 1);
    if (!previous.text.trim()) break;
    line = previous;
  }
  return line.from;
}

/**
 * Where to scan from for a window starting at `from`, and the environments
 * open there. A scan cannot start inside math or a verbatim block (it would
 * read them as text), nor inside a list (its items are numbered from the
 * top), so it starts at the block's `\begin` instead when that is near.
 */
export function scanContext(state: EditorState, from: number): { start: number; frames: ScanFrame[] } {
  const start = paragraphStart(state, from);
  const open = openEnvironments(state, start);
  const index = open.findIndex(({ name, from: at }) => (
    LIST_ENVIRONMENTS.has(name) || SOURCE_ENVIRONMENTS.has(name) || DISPLAY_MATH_ENVIRONMENTS.has(name)
  ) && start - at <= LIST_REACH);
  if (index >= 0) {
    return { start: open[index].from, frames: open.slice(0, index).map(({ name }) => ({ name, items: 0 })) };
  }
  return { start, frames: open.map(({ name }) => ({ name, items: 0 })) };
}

/** Whether `changes` touch the text before `position` (which would change what is open there). */
function touchesBefore(changes: ChangeSet, position: number): boolean {
  let touched = false;
  changes.iterChangedRanges((fromA) => {
    if (fromA < position) touched = true;
  });
  return touched;
}

/** The window for a view: whole lines around its viewport. */
function windowFor(view: EditorView): Span {
  const { doc } = view.state;
  const { from, to } = view.viewport;
  const first = doc.line(Math.max(1, doc.lineAt(from).number - WINDOW_MARGIN_LINES));
  const last = doc.line(Math.min(doc.lines, doc.lineAt(to).number + WINDOW_MARGIN_LINES));
  return { from: first.from, to: last.to };
}

/**
 * Whether `window` still serves a view: it covers the viewport, and has not
 * grown far past what the view needs (a large paste inside it widens it,
 * and every keystroke would scan all of it again).
 */
function serves(window: Span | null, view: EditorView): boolean {
  if (!window || window.from > view.viewport.from || window.to < view.viewport.to) return false;
  const needed = windowFor(view);
  return window.to - window.from <= 3 * (needed.to - needed.from) + WINDOW_SLACK;
}
/** A window this much longer than it needs to be is still kept. */
const WINDOW_SLACK = 20_000;

function sameSets(a: readonly RangeSet<RangeValue>[], b: readonly RangeSet<RangeValue>[]): boolean {
  return a.length === b.length && a.every((set, index) => set === b[index]);
}

/** The preamble Visual mode folds away, when `\begin{document}` ends its line. */
function preambleOf(state: EditorState): Preamble {
  const { begin } = documentBounds(state);
  if (!begin) return null;
  const line = state.doc.lineAt(begin.to);
  return line.text.slice(begin.to - line.from).trim() ? null : { to: line.to };
}

/** `\end{document}`'s line, when the token is alone on it. */
function endDocumentOf(state: EditorState): Span | null {
  const { end } = documentBounds(state);
  if (!end) return null;
  const line = state.doc.lineAt(end.from);
  return line.text.trim() === state.sliceDoc(end.from, end.to).trim() ? { from: line.from, to: line.to } : null;
}

export function latexVisual(host: LatexVisualHost): Extension {
  /** The last build's label numbers, read once per build (compiled-labels.ts caches the read). */
  const aux: { build: CompiledBuild | undefined; labels: Map<string, CompiledLabel> | null } = { build: undefined, labels: null };

  const draw = (state: EditorState, value: Omit<VisualState, "revealed" | "replacements">, force: boolean, previous: VisualState | null): VisualState => {
    const points = selectionPoints(value.frozen ?? state.selection);
    const revealed = revealedConstructs(state, value.constructs, points, value.overlays);
    const preamble = preambleOf(state);
    const preambleRevealed = preamble !== null && (points.some((point) => point <= preamble.to) || overlaysTouch(value.overlays, 0, preamble.to));
    const endSpan = endDocumentOf(state);
    const endRevealed = endSpan !== null
      && (points.some((point) => point >= endSpan.from && point <= endSpan.to) || overlaysTouch(value.overlays, endSpan.from, endSpan.to));
    const key = `${revealed.map((shown) => (shown ? 1 : 0)).join("")}|${preambleRevealed ? 1 : 0}|${endRevealed ? 1 : 0}`;
    if (!force && previous && key === previous.revealed) return { ...previous, frozen: value.frozen, overlays: value.overlays };
    const replacements = buildReplacements(
      { state, host, labels: aux.labels }, value.constructs, revealed,
      { span: preamble, revealed: preambleRevealed }, endSpan && { span: endSpan, revealed: endRevealed },
    );
    return { ...value, revealed: key, replacements };
  };

  const scan = (state: EditorState, window: Span | null, context: VisualState["context"]) => {
    if (!window) return { context, constructs: [] as Construct[], styles: buildStyles(state, [], [], { from: 0, to: 0 }) };
    const scanContextNow = context && context.start <= window.from ? context : scanContext(state, window.from);
    const to = Math.min(window.to, state.doc.length);
    const { constructs } = scanConstructs(state.sliceDoc(scanContextNow.start, to), scanContextNow.start, scanContextNow.frames);
    return { context: scanContextNow, constructs, styles: buildStyles(state, constructs, scanContextNow.frames, { from: scanContextNow.start, to }) };
  };

  const field = StateField.define<VisualState>({
    create(state) {
      const overlays = state.facet(sourceOverlays).map((ranges) => ranges(state));
      const scanned = scan(state, null, null);
      return draw(state, { window: null, frozen: null, overlays, ...scanned }, true, null);
    },
    update(value, transaction) {
      const { state } = transaction;
      let { window, frozen, context } = value;
      let rescan = false;
      let redraw = false;
      for (const effect of transaction.effects) {
        if (effect.is(setWindow)) {
          window = effect.value;
          // A new window reads what is open at its own start.
          context = null;
          rescan = true;
        } else if (effect.is(pointerPressed)) {
          frozen = transaction.startState.selection;
        } else if (effect.is(latexVisualDataChanged)) {
          redraw = true;
        }
      }
      if (isPointerRelease(transaction)) frozen = null;
      if (transaction.docChanged) {
        const { changes } = transaction;
        if (window) {
          const from = state.doc.lineAt(changes.mapPos(window.from, -1)).from;
          window = { from, to: state.doc.lineAt(Math.max(from, changes.mapPos(window.to, 1))).to };
        }
        frozen = frozen?.map(changes) ?? null;
        context = context && !touchesBefore(changes, context.start) ? { ...context, start: changes.mapPos(context.start, -1) } : null;
        rescan = true;
      }
      const overlays = state.facet(sourceOverlays).map((ranges) => ranges(state));
      const overlaysChanged = !sameSets(overlays, value.overlays);
      if (!rescan && !redraw && !overlaysChanged && !transaction.selection && frozen === value.frozen) return value;
      const scanned = rescan ? scan(state, window, context) : { context, constructs: value.constructs, styles: value.styles };
      return draw(state, { window, frozen, overlays, ...scanned }, rescan || redraw, value);
    },
    provide: (self) => [
      // Styles first: their marks wrap the widgets (a symbol inside bold text is bold).
      EditorView.decorations.from(self, (value) => value.styles),
      EditorView.decorations.from(self, (value) => value.replacements),
      EditorView.atomicRanges.of((view) => view.state.field(self).replacements),
    ],
  });

  const windowPlugin = ViewPlugin.define((view) => {
    let scheduled = false;
    let destroyed = false;
    const syncWindow = () => {
      if (scheduled) return;
      scheduled = true;
      // After the update that moved the viewport: a view cannot be dispatched to inside one.
      queueMicrotask(() => {
        scheduled = false;
        if (destroyed) return;
        const value = view.state.field(field, false);
        if (!value || serves(value.window, view)) return;
        view.dispatch({ effects: setWindow.of(windowFor(view)) });
      });
    };
    const syncLabels = () => {
      const { compiledBuild, projectRoot } = host.data();
      if (compiledBuild === aux.build) return;
      aux.build = compiledBuild;
      aux.labels = null;
      if (!compiledBuild) return;
      void compiledLabels(projectRoot, compiledBuild).then((labels) => {
        if (destroyed || aux.build !== compiledBuild) return;
        aux.labels = labels;
        view.dispatch({ effects: latexVisualDataChanged.of(null) });
      }, () => {});
    };
    // A caret left at the very start (a document just opened) would open the folded preamble: start at the body instead.
    const preamble = preambleOf(view.state);
    const { main } = view.state.selection;
    if (preamble && main.empty && main.head === 0 && preamble.to < view.state.doc.length) {
      queueMicrotask(() => {
        if (!destroyed && view.state.selection.main.head === 0) view.dispatch({ selection: { anchor: preamble.to + 1 } });
      });
    }
    syncWindow();
    syncLabels();
    return {
      update(update: ViewUpdate) {
        if (update.viewportChanged || update.docChanged || update.geometryChanged) syncWindow();
        syncLabels();
      },
      destroy() {
        destroyed = true;
      },
    };
  });

  return [
    environmentIndex,
    field,
    windowPlugin,
    pointerSelection,
    EditorView.editorAttributes.of({ class: "cm-latex-visual" }),
    // Before CodeMirror reads the press: from here until the release, constructs stay as they were drawn.
    Prec.highest(EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button === 0) view.dispatch({ effects: pointerPressed.of(null) });
        return false;
      },
    })),
    itemCaretGuard(field),
    Prec.highest(keymap.of([
      { key: "Backspace", run: deleteAcrossTokens(field, false), shift: deleteAcrossTokens(field, false) },
      { key: "Delete", run: deleteAcrossTokens(field, true) },
      /* eslint-disable lingui/no-unlocalized-strings -- CodeMirror key names, never shown */
      { mac: "Ctrl-h", run: deleteAcrossTokens(field, false) },
      { mac: "Ctrl-d", run: deleteAcrossTokens(field, true) },
      { mac: "Alt-Backspace", run: deleteVisible(field, "group", false), preventDefault: true },
      { mac: "Alt-Delete", run: deleteVisible(field, "group", true), preventDefault: true },
      { mac: "Ctrl-Alt-h", run: deleteVisible(field, "group", false) },
      { mac: "Mod-Backspace", run: deleteVisible(field, "wrap", false), preventDefault: true },
      { mac: "Mod-Delete", run: deleteVisible(field, "wrap", true), preventDefault: true },
      { mac: "Ctrl-k", run: deleteVisible(field, "line", true) },
      /* eslint-enable lingui/no-unlocalized-strings */
    ])),
    unwrapOnDelete(field),
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

function tokenPairs(value: VisualState): TokenPair[] {
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
function drawnRange(value: VisualState, token: Span): Span | null {
  let range: Span | null = null;
  value.replacements.between(token.from, token.to, (from, to) => {
    if (from > token.from || to < token.to || (from !== token.from && to !== token.to)) return;
    range = { from, to };
    return false;
  });
  return range;
}

/** The tokens a deletion steps over, as the ranges they are drawn as (a heading's or caption's even when not drawn). */
function steppedTokens(value: VisualState, pairs: readonly TokenPair[]) {
  return pairs.flatMap((pair) => (["open", "close"] as const).flatMap((side) => {
    const span = drawnRange(value, pair[side]) ?? (pair.always ? pair[side] : null);
    return span ? [{ span, pair, side }] : [];
  }));
}

/** Removes `ranges` from the caret's deletion; the caret keeps its place in the text before or after them. */
function removeRanges(view: EditorView, forward: boolean, ranges: readonly Span[]): true {
  const { head } = view.state.selection.main;
  const before = ranges.reduce((sum, { from, to }) => sum + (to <= head ? to - from : 0), 0);
  view.dispatch({ changes: [...ranges], selection: { anchor: head - before }, scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward" });
  return true;
}

function deleteAcrossTokens(field: StateField<VisualState>, forward: boolean): Command {
  return (view) => {
    const { state } = view;
    const value = state.field(field, false);
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
function deleteVisible(field: StateField<VisualState>, unit: "group" | "wrap" | "line", forward: boolean): Command {
  const byCharacter = deleteAcrossTokens(field, forward);
  return (view) => {
    const { state } = view;
    const value = state.field(field, false);
    const { main } = state.selection;
    if (!value || state.selection.ranges.length > 1 || !main.empty) return false;
    const pairs = tokenPairs(value);
    const steps = steppedTokens(value, pairs);
    const hidden = steps.map(({ span }) => span);
    const line = state.doc.lineAt(main.head);
    const widgets: Span[] = [];
    value.replacements.between(line.from, line.to, (from, to) => {
      if (from < to) widgets.push({ from, to });
    });
    // The line as drawn: each character, a widget as one, the hidden tokens left out.
    const units: { from: number; to: number; text: string }[] = [];
    for (let pos = line.from; pos < line.to;) {
      const token = hidden.find(({ from, to }) => from <= pos && to > pos);
      if (token) {
        pos = token.to;
        continue;
      }
      const widget = widgets.find(({ from, to }) => from <= pos && to > pos);
      const to = widget ? Math.min(widget.to, line.to) : line.from + findClusterBreak(line.text, pos - line.from, true);
      units.push({ from: pos, to, text: widget ? "\uFFFC" : state.sliceDoc(pos, to) });
      pos = to;
    }
    const caret = units.filter(({ to }) => to <= main.head).length;
    let gone: typeof units;
    if (unit === "group") {
      const categorize = state.charCategorizer(main.head);
      const first = forward ? caret : caret - 1;
      let end = caret;
      let category: ReturnType<typeof categorize> | null = null;
      for (let index = first; index >= 0 && index < units.length; index += forward ? 1 : -1) {
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
    const ranges: Span[] = gone.map(({ from, to }) => ({ from, to }));
    for (const pair of pairs) {
      if (pair.open.from < line.from || pair.close.to > line.to) continue;
      const content = units.filter(({ from, to }) => from >= pair.open.to && to <= pair.close.from);
      if (!content.length || !content.every((item) => gone.includes(item))) continue;
      ranges.push(...steps.filter((step) => step.pair === pair).map(({ span }) => span));
    }
    return removeRanges(view, forward, ranges.sort((a, b) => a.from - b.from));
  };
}

function unwrapOnDelete(field: StateField<VisualState>): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !(transaction.isUserEvent("delete") || transaction.isUserEvent("input"))) return transaction;
    const value = transaction.startState.field(field, false);
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

/**
 * The caret never rests before a list item's marker, where it would sit
 * left of the bullet: arriving there it moves past the marker, and stepping
 * left from just past it goes on to the end of the line above.
 */
function itemCaretGuard(field: StateField<VisualState>): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.selection || transaction.docChanged) return transaction;
    const { selection } = transaction;
    if (selection.ranges.length !== 1 || !selection.main.empty) return transaction;
    const value = transaction.startState.field(field, false);
    if (!value) return transaction;
    const head = selection.main.head;
    const { doc } = transaction.startState;
    for (const construct of value.constructs) {
      if (construct.kind !== "item") continue;
      const line = doc.lineAt(construct.from);
      const start = line.text.slice(0, construct.from - line.from).trim() ? construct.from : line.from;
      const end = construct.term ? construct.term.from : construct.to;
      if (head < start || head >= end) continue;
      const previous = transaction.startState.selection.main.head;
      const target = previous === end && head < previous && start > 0 ? start - 1 : end;
      return [transaction, { selection: { anchor: target }, sequential: true }];
    }
    return transaction;
  });
}
