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
import { EditorSelection, EditorState, Prec, StateEffect, StateField, type ChangeSet, type Extension, type RangeSet, type RangeValue } from "@codemirror/state";
import { EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { compiledLabels, type CompiledBuild, type CompiledLabel } from "../compiled-labels";
import { compiledCompoundNumbers } from "../compound-project";
import type { CompoundNumbers } from "../compound-keys";
import { latexVisualDataChanged, type LatexVisualHost } from "../latex-visual-switch";
import { isPointerRelease, pointerSelection } from "../../pointer-selection";
import { overlaysTouch, sourceOverlays } from "../../source-overlays";
import { buildReplacements, buildStyles, revealedConstructs, selectionPoints } from "./visual-decorations";
import { visualDeletion } from "./visual-deletion";
import { endDocumentOf, environmentIndex, openEnvironments, preambleOf } from "./visual-environments";
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

export function latexVisual(host: LatexVisualHost): Extension {
  /** The last build's label and compound numbers, read once per build (compiled-labels.ts and compound-project.ts cache the reads). */
  const aux: { build: CompiledBuild | undefined; labels: Map<string, CompiledLabel> | null; compounds: CompoundNumbers | null } = {
    build: undefined, labels: null, compounds: null,
  };

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
      { state, host, labels: aux.labels, compounds: aux.compounds }, value.constructs, revealed,
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
      aux.compounds = null;
      if (!compiledBuild) return;
      void Promise.all([
        compiledLabels(projectRoot, compiledBuild),
        compiledCompoundNumbers(projectRoot, compiledBuild).catch(() => null),
      ]).then(([labels, compounds]) => {
        if (destroyed || aux.build !== compiledBuild) return;
        aux.labels = labels;
        aux.compounds = compounds;
        view.dispatch({ effects: latexVisualDataChanged.of(null) });
      }, () => {});
    };
    // The project data drawn from (macros, the last build, citations, paths)
    // is read here, on the editor's own updates, rather than pushed from the
    // canvas: a hook there would run on every keystroke, Visual or not. A
    // change shows on the next update (a keystroke, scroll, resize or focus).
    const drawnFrom = () => {
      const { katexMacros, compiledBuild, citations, references, projectPaths, graphicsRoots, rootDocumentPath } = host.data();
      return [katexMacros, compiledBuild, citations, references, projectPaths, graphicsRoots, rootDocumentPath];
    };
    let seen = drawnFrom();
    let redrawScheduled = false;
    const syncData = (update: ViewUpdate) => {
      // The redraw asked for below is never a reason to ask again: a host whose
      // data() builds fresh values per call would otherwise redraw forever.
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(latexVisualDataChanged)))) return;
      const current = drawnFrom();
      if (current.every((value, index) => value === seen[index])) return;
      seen = current;
      if (redrawScheduled) return;
      redrawScheduled = true;
      queueMicrotask(() => {
        redrawScheduled = false;
        if (!destroyed) view.dispatch({ effects: latexVisualDataChanged.of(null) });
      });
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
        syncData(update);
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
    visualDeletion((state) => state.field(field, false)),
  ];
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
