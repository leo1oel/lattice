/**
 * Review mode in the source editor: the writer's changes since the base
 * drawn as Overleaf's suggestions are (an insertion underlined, a deletion
 * struck through at the point it left), with the same hover card to accept
 * or reject one, and the commands the review bar runs.
 *
 * The base is part of the editor state, so accepting a change is an undo
 * step like rejecting one (which edits the text): ⌘Z takes back either, and
 * the changes are worked out again from the base and the text, so they can
 * never disagree with what is on screen. Every transaction that moves the
 * base is written back to the store (review-mode-store.ts), which saves it.
 *
 * A co-author's edit that arrives from Overleaf is not the writer's change:
 * the store names its text in advance, and the transaction that brings it in
 * carries the base forward with it (`advancedBase`).
 */
import { invertedEffects } from "@codemirror/commands";
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, showPanel, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import type { TrackedChange } from "../overleaf/overleaf-realtime-model";
import {
  buildTrackedChangeDecorations, buildTrackedChangeTooltipDom, trackedChangeRange, trackedChangesAtPosition,
} from "../overleaf/overleaf-editor-extensions";
import {
  acceptedBase, advancedBase, rejectAllEdits, rejectEdit, reviewChanges, reviewHunks, type ReviewHunk,
} from "./review-mode-diff";
import { reviewMode, type ReviewModeStore } from "./review-mode-store";
import { hoverAnchor } from "../editor/hover-anchor";

type Review = Readonly<{
  /** Null while review mode is off for this file. */
  base: string | null;
  hunks: readonly ReviewHunk[];
  changes: readonly TrackedChange[];
  decorations: DecorationSet;
}>;

/**
 * A new base. `step` marks the writer's accept (and its undo and redo): it
 * names the review mode it belongs to and the base it replaces, and is not
 * applied once either has moved on (review mode turned off, or a co-author's
 * edit carried into the base since). Null for the store turning review mode
 * on or off, which is no undo step.
 */
type Step = Readonly<{ session: string; from: string | null }>;
const setBase = StateEffect.define<{ base: string | null; step: Step | null }>();

const OFF: Review = { base: null, hunks: [], changes: [], decorations: Decoration.none };

function review(state: EditorState, base: string | null): Review {
  if (base === null) return OFF;
  const text = state.doc.toString();
  const hunks = reviewHunks(base, text);
  const changes = reviewChanges(base, text, hunks);
  return { base, hunks, changes, decorations: buildTrackedChangeDecorations(state.doc, [...changes]) };
}

function reviewField(path: string, store: ReviewModeStore) {
  return StateField.define<Review>({
    create: (state) => review(state, store.baseFor(path)),
    update(value, tr) {
      let base = value.base;
      for (const effect of tr.effects) {
        if (!effect.is(setBase)) continue;
        const { step } = effect.value;
        if (step === null || (step.session === store.session() && step.from === base)) base = effect.value.base;
      }
      if (base === value.base && !tr.docChanged) return value;
      if (base !== null && base === value.base && isCoauthorEdit(tr, path, store)) {
        const advanced = advancedBase(base, tr.startState.doc.toString(), value.hunks, tr.changes);
        base = advanced.base;
        // Said once the transaction is through: React hears the store, and a state update is no place to render.
        if (advanced.touched) queueMicrotask(() => store.setNotice(i18n._(msg`A co-author edited text you changed. Both versions are kept.`)));
      }
      return review(tr.state, base);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

function isCoauthorEdit(tr: Transaction, path: string, store: ReviewModeStore): boolean {
  if (!tr.docChanged) return false;
  let text: string | null = null;
  return store.takeCoauthorText(path, (noted) => noted.length === tr.newDoc.length && noted === (text ??= tr.newDoc.toString()));
}

/** Each review editor's field and store: one per file, so the commands look them up by view. */
const viewFields = new WeakMap<EditorView, { field: StateField<Review>; store: ReviewModeStore }>();

/** The review in `view`: its base, hunks and changes, or null while review mode is off there. */
export function reviewOf(view: EditorView): Review | null {
  const field = viewFields.get(view)?.field;
  const value = field ? view.state.field(field, false) : undefined;
  return value && value.base !== null ? value : null;
}

/** The writer's accept in `view`: the base becomes `base`, one undo step. */
function acceptBase(view: EditorView, base: string) {
  const session = viewFields.get(view)?.store.session() ?? null;
  const from = reviewOf(view)?.base ?? null;
  if (session !== null) view.dispatch({ effects: setBase.of({ base, step: { session, from } }), userEvent: "review.accept" });
}

/** The hunk at the caret (touching either end counts), or the first after it; its index, or -1. */
function hunkIndexAt(hunks: readonly ReviewHunk[], pos: number, after = false): number {
  const at = hunks.findIndex((hunk) => hunk.from <= pos && pos <= hunk.to);
  if (at >= 0 || !after) return at;
  return hunks.findIndex((hunk) => hunk.from > pos);
}

function select(view: EditorView, hunk: ReviewHunk | undefined) {
  if (!hunk) return;
  view.dispatch({
    selection: hunk.to > hunk.from ? EditorSelection.range(hunk.from, hunk.to) : EditorSelection.cursor(hunk.from),
    effects: EditorView.scrollIntoView(hunk.from, { y: "center" }),
    userEvent: "select.review",
  });
}

function lastIndexBefore(hunks: readonly ReviewHunk[], pos: number): number {
  for (let index = hunks.length - 1; index >= 0; index -= 1) if (hunks[index]!.from < pos) return index;
  return -1;
}

/** Select the next (or previous) change, wrapping round at the end. */
export function moveToChange(view: EditorView, direction: 1 | -1): boolean {
  const value = reviewOf(view);
  if (!value?.hunks.length) return false;
  const { hunks } = value;
  const { from, to } = view.state.selection.main;
  const index = direction > 0
    ? hunks.findIndex((hunk) => hunk.from > from || (hunk.from === from && hunk.to > to))
    : lastIndexBefore(hunks, from);
  select(view, hunks[index >= 0 ? index : direction > 0 ? 0 : hunks.length - 1]);
  view.focus();
  return true;
}

/**
 * Accept (or reject) a whole hunk, its deletion and insertion together, then
 * (`moveOn`) select the next one, as Word's Accept and Move to Next does.
 */
export function decideHunk(view: EditorView, index: number, accept: boolean, moveOn = true): boolean {
  const value = reviewOf(view);
  const hunk = value?.hunks[index];
  if (!value || value.base === null || !hunk) return false;
  if (accept) {
    acceptBase(view, acceptedBase(value.base, view.state.doc.toString(), hunk));
  } else {
    view.dispatch({ changes: rejectEdit(value.base, hunk), userEvent: "review.reject" });
  }
  const next = reviewOf(view);
  const pos = accept ? hunk.to : hunk.from + (hunk.baseTo - hunk.baseFrom);
  if (moveOn && next?.hunks.length) select(view, next.hunks[Math.max(0, hunkIndexAt(next.hunks, pos, true))]);
  return true;
}

/** Accept the hunk at the caret, or reject it. */
export function decideAtCaret(view: EditorView, accept: boolean): boolean {
  const value = reviewOf(view);
  if (!value) return false;
  return decideHunk(view, hunkIndexAt(value.hunks, view.state.selection.main.head), accept);
}

/** The hunk a change drawn from it names (`review:<index>:…`), while it is still where it was drawn. */
function hunkIndexOf(view: EditorView, change: TrackedChange): number {
  const index = Number(change.id.split(":")[1]);
  return reviewOf(view)?.hunks[index]?.from === change.position ? index : -1;
}

/** What a hunk did, in words, for its hover card. */
function describeHunk(base: string, text: string, hunk: ReviewHunk | undefined): string {
  if (!hunk) return "";
  const removed = base.slice(hunk.baseFrom, hunk.baseTo);
  const added = text.slice(hunk.from, hunk.to);
  if (!removed) return i18n._(msg`Inserted “${added}”`);
  if (!added) return i18n._(msg`Deleted “${removed}”`);
  return i18n._(msg`Replaced “${removed}” with “${added}”`);
}

/** Accept every change: the base becomes the text. One undo step. */
export function acceptAll(view: EditorView): boolean {
  const value = reviewOf(view);
  if (!value?.hunks.length) return false;
  acceptBase(view, view.state.doc.toString());
  return true;
}

/** Reject every change: the text goes back to the base. One undo step. */
export function rejectAll(view: EditorView): boolean {
  const value = reviewOf(view);
  if (!value?.hunks.length || value.base === null) return false;
  view.dispatch({ changes: rejectAllEdits(value.base, value.hunks), userEvent: "review.reject" });
  return true;
}

/** What the review bar shows for one editor. */
type ReviewBarState = Readonly<{ count: number; index: number }>;

/** The editor hosting a review bar: its panel, and word whenever what the bar shows changes. */
export type ReviewPanel = Readonly<{
  view: EditorView;
  dom: HTMLElement;
  path: string;
  read: () => ReviewBarState;
  subscribe: (listener: () => void) => () => void;
}>;

const panels = new Set<ReviewPanel>();
const panelListeners = new Set<() => void>();
let panelSnapshot: readonly ReviewPanel[] = [];
const announcePanels = () => {
  panelSnapshot = [...panels];
  for (const listener of panelListeners) listener();
};

/** The review bars on screen, for the component that draws into them (review-mode-bar.tsx). */
export const reviewPanels = {
  subscribe(listener: () => void) {
    panelListeners.add(listener);
    return () => void panelListeners.delete(listener);
  },
  get: () => panelSnapshot,
};

function barState(view: EditorView): ReviewBarState {
  const value = reviewOf(view);
  if (!value) return { count: 0, index: -1 };
  return { count: value.hunks.length, index: hunkIndexAt(value.hunks, view.state.selection.main.head) };
}

function reviewPanel(path: string) {
  return (view: EditorView) => {
    const dom = document.createElement("div");
    dom.className = "cm-review-bar";
    let current = barState(view);
    const listeners = new Set<() => void>();
    const panel: ReviewPanel = {
      view, dom, path,
      read: () => current,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    return {
      dom,
      top: true,
      mount() {
        panels.add(panel);
        announcePanels();
      },
      update(update: ViewUpdate) {
        const next = barState(update.view);
        if (next.count === current.count && next.index === current.index) return;
        current = next;
        for (const listener of listeners) listener();
      },
      destroy() {
        panels.delete(panel);
        announcePanels();
      },
    };
  };
}

/** Review mode for the editor of `path`: its marks, hover card, bar and undoable accepts. */
export function reviewModeExtension(path: string, store: ReviewModeStore = reviewMode): Extension {
  const field = reviewField(path, store);
  const panel = reviewPanel(path);
  const sync = ViewPlugin.fromClass(class {
    private readonly unregister: () => void;

    constructor(readonly view: EditorView) {
      viewFields.set(view, { field, store });
      // A base the store changed (review mode turned on or off) is not the writer's undo step.
      const apply = (base: string | null) => {
        if (base !== view.state.field(field).base) view.dispatch({ effects: setBase.of({ base, step: null }) });
      };
      this.unregister = store.register(path, view, apply);
      // A parked editor comes back with the base it was parked with; the
      // store's may have moved since (review mode turned off, say). Not
      // during this update: a view cannot dispatch while it is being built.
      queueMicrotask(() => {
        if (!this.destroyed) apply(store.baseFor(path));
      });
    }

    private destroyed = false;

    update(update: ViewUpdate) {
      const base = update.state.field(field).base;
      if (base !== null && base !== update.startState.field(field).base) store.setBase(path, base);
    }

    destroy() {
      this.destroyed = true;
      this.unregister();
    }
  });
  const hover = hoverTooltip((view, pos) => {
    const value = view.state.field(field);
    if (value.base === null) return null;
    const hits = trackedChangesAtPosition(view.state.doc, [...value.changes], pos);
    if (!hits.length) return null;
    let from = pos;
    let to = pos;
    for (const change of hits) {
      const range = trackedChangeRange(view.state.doc, change)!;
      from = Math.min(from, range.from);
      to = Math.max(to, range.to);
    }
    // One card per hunk: a replacement's two halves are accepted together.
    const cards = [...new Map(hits.map((change) => [change.id.split(":")[1], change])).values()];
    const base = value.base;
    const line = view.state.doc.lineAt(pos);
    const start = Math.max(from, line.from);
    return {
      pos: start,
      end: Math.min(to, line.to),
      above: true,
      arrow: true,
      create: () => ({
        getCoords: hoverAnchor(view, start),
        dom: buildTrackedChangeTooltipDom(cards, {
          authorName: () => i18n._(msg({ message: "You", context: "the writer, as the author of a tracked change" })),
          describe: (change) => describeHunk(base, view.state.doc.toString(), value.hunks[Number(change.id.split(":")[1])]),
          canAct: () => true,
          onAccept: (change) => decideHunk(view, hunkIndexOf(view, change), true, false),
          onReject: (change) => decideHunk(view, hunkIndexOf(view, change), false, false),
        }),
        resize: false,
      }),
    };
  });
  return [
    field,
    sync,
    hover,
    invertedEffects.of((tr) => tr.effects.flatMap((effect) => (effect.is(setBase) && effect.value.step !== null
      ? [setBase.of({ base: tr.startState.field(field).base, step: { session: effect.value.step.session, from: effect.value.base } })]
      : []))),
    showPanel.compute([field], (state) => (state.field(field).base === null ? null : panel)),
  ];
}
