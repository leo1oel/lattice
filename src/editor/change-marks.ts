/**
 * A moment's mark on text that changed under the writer, so the eye finds
 * what moved without reading the page again:
 *
 * - An accepted suggestion (the inline Proofread and Polish): each replaced
 *   passage is struck through and folds away, then its new words settle in
 *   on a wash that lingers and fades. The document changes at once; the old
 *   words are only a picture, a widget that is gone when the moment is.
 * - An outside edit that landed in the open file (the agent's, another
 *   app's): its lines take a wash that lingers and fades.
 *
 * Marks only, never the text: they map through edits made meanwhile and are
 * dropped when their moment ends, and a state parked with its tab does not
 * bring them back. The motion is the stylesheet's (`.cm-accept-*`,
 * `.cm-landed-line` in editor-workspace.css), so reduced motion settles it.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { takeLandedText } from "./landed-text";

/**
 * How long a mark stays: the longest moment is the last accepted edit's
 * wash, which waits for the strikes before it (`--duration-linger` and the
 * delays in editor-workspace.css), with room to finish.
 */
export const CHANGE_MARK_MS = 2600;
/** Edits after this many arrive together, as the card's own edits do. */
const MAX_STAGGER = 8;
/** A longer passage, or one over a line break, leaves at once rather than as a picture. */
const MAX_GHOST_LENGTH = 80;
/** An outside edit marks its first lines this many at most: a rewritten file is not a highlighter. */
const MAX_LANDED_LINES = 200;

/** One accepted edit in the new document: `[from, to)` now reads its new words, which replaced `removed`. */
export type AcceptedEdit = { from: number; to: number; removed: string };

/** Mark `edits`, positioned in the document of the transaction that carries this effect. */
export const markAcceptedEdits = StateEffect.define<readonly AcceptedEdit[]>();
const clearChangeMarks = StateEffect.define<null>();

/** The words an accepted edit replaced, struck and folding away where they stood. */
class RemovedWords extends WidgetType {
  constructor(readonly text: string, readonly order: number) {
    super();
  }

  eq(other: RemovedWords) {
    return other.text === this.text && other.order === this.order;
  }

  toDOM() {
    const ghost = document.createElement("span");
    ghost.className = "cm-accept-ghost";
    ghost.style.setProperty("--change-mark-order", String(this.order));
    ghost.setAttribute("aria-hidden", "true");
    const words = ghost.appendChild(document.createElement("span"));
    words.textContent = this.text;
    // The fold runs from the words' own width, which is known once drawn.
    requestAnimationFrame(() => {
      if (!ghost.isConnected) return;
      ghost.style.setProperty("--change-mark-width", `${ghost.getBoundingClientRect().width}px`);
      ghost.setAttribute("data-measured", "");
    });
    return ghost;
  }

  ignoreEvent() {
    return true;
  }
}

function acceptedMarks(edits: readonly AcceptedEdit[], state: EditorState): Range<Decoration>[] {
  const length = state.doc.length;
  return [...edits].sort((left, right) => left.from - right.from).flatMap((edit, index) => {
    const order = Math.min(index, MAX_STAGGER);
    const from = Math.min(edit.from, length);
    const to = Math.min(Math.max(edit.to, from), length);
    const removed = edit.removed.trim();
    const marks: Range<Decoration>[] = [];
    if (removed && removed.length <= MAX_GHOST_LENGTH && !/\n/.test(removed)) {
      marks.push(Decoration.widget({ widget: new RemovedWords(edit.removed, order), side: -1 }).range(from));
    }
    if (to > from) {
      marks.push(Decoration.mark({
        class: "cm-accept-insert",
        attributes: { style: `--change-mark-order: ${order}` },
      }).range(from, to));
    }
    return marks;
  });
}

const landedLine = Decoration.line({ class: "cm-landed-line" });

/**
 * The lines `transaction` wrote, in its new document, as wash marks. The
 * editor takes outside text as one replacement from the first difference to
 * the last (text-change.ts), so a line inside it that reads as one the
 * replaced span already had is not new and keeps no mark.
 */
function landedMarks(transaction: Transaction): Range<Decoration>[] {
  const before = transaction.startState.doc;
  const doc = transaction.newDoc;
  const marks: Range<Decoration>[] = [];
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const had = new Map<string, number>();
    for (let line = before.lineAt(fromA).number, last = before.lineAt(toA).number; line <= last; line += 1) {
      const text = before.line(line).text;
      had.set(text, (had.get(text) ?? 0) + 1);
    }
    for (let line = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; line <= last && marks.length < MAX_LANDED_LINES; line += 1) {
      const { from, text } = doc.line(line);
      const left = had.get(text) ?? 0;
      if (left) had.set(text, left - 1);
      else marks.push(landedLine.range(from));
    }
  }, true);
  return marks;
}

type ChangeMarks = { marks: DecorationSet; until: number };
const NO_MARKS: ChangeMarks = { marks: Decoration.none, until: 0 };

const changeMarks = StateField.define<ChangeMarks>({
  create: () => NO_MARKS,
  update(value, transaction) {
    let next = value.marks === Decoration.none ? value
      : Date.now() < value.until ? { ...value, marks: value.marks.map(transaction.changes) } : NO_MARKS;
    const added: Range<Decoration>[] = [];
    for (const effect of transaction.effects) {
      if (effect.is(clearChangeMarks)) next = NO_MARKS;
      else if (effect.is(markAcceptedEdits)) added.push(...acceptedMarks(effect.value, transaction.state));
    }
    // An outside edit arrives as the editor's new text, noted beforehand
    // (landed-text.ts); only a change that ends in exactly that text is it.
    if (transaction.docChanged && takeLandedText((text) => text.length === transaction.newDoc.length && text === transaction.newDoc.toString())) {
      added.push(...landedMarks(transaction));
    }
    if (!added.length) return next;
    return { marks: next.marks.update({ add: added, sort: true }), until: Date.now() + CHANGE_MARK_MS };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
});

/** Takes the marks away when their moment ends; a view that goes takes its timer with it. */
const changeMarksLifetime = ViewPlugin.fromClass(class {
  timer = 0;
  until = 0;

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    const { until } = update.state.field(changeMarks);
    if (until === this.until) return;
    this.until = until;
    window.clearTimeout(this.timer);
    if (!until) return;
    this.timer = window.setTimeout(() => this.view.dispatch({ effects: clearChangeMarks.of(null) }), Math.max(0, until - Date.now()));
  }

  destroy() {
    window.clearTimeout(this.timer);
  }
});

/** For every source editor whose text can change under the writer. */
export function changeMarksExtension(): Extension {
  return [changeMarks, changeMarksLifetime];
}
