/**
 * How a source editor lands on a place it was sent to — a TODO, an outline
 * entry, a find result, a diagnostic, a SyncTeX click, a comment, a step back:
 * one move straight to the target, the target centered in the viewport, the
 * caret or selection on it, and its lines briefly marked so the eye finds it.
 *
 * Centering needs room below the last line, or a target near the end of a
 * document is pinned to the bottom edge instead (the scroller cannot go
 * further), so the editors that take jumps scroll past their end.
 */
import { StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, scrollPastEnd, type DecorationSet } from "@codemirror/view";
import { clamp } from "../settings/app-settings";
import { focusWhenShown } from "./focus-when-shown";

/** How long a revealed target stays marked; the CSS animation (`.cm-reveal-flash`) fades within it. */
export const REVEAL_FLASH_MS = 1600;
/** A long selection marks only its first lines: the mark is a pointer, not a highlighter. */
const MAX_FLASH_LINES = 12;

const setRevealFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashLine = Decoration.line({ class: "cm-reveal-flash" });

function flashedLines(doc: Text, from: number, to: number): DecorationSet {
  const first = doc.lineAt(from).number;
  const last = Math.min(doc.lineAt(to).number, first + MAX_FLASH_LINES - 1);
  const ranges = [];
  for (let number = first; number <= last; number += 1) ranges.push(flashLine.range(doc.line(number).from));
  return Decoration.set(ranges);
}

const revealFlash = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(flash, transaction) {
    let next = flash.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setRevealFlash)) continue;
      next = effect.value ? flashedLines(transaction.state.doc, effect.value.from, effect.value.to) : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** For every editor that can be sent somewhere: room to center the last lines, and the target's mark. */
export function revealExtension(): Extension {
  return [scrollPastEnd(), revealFlash];
}

const flashTimers = new WeakMap<EditorView, number>();

/**
 * Send `view` to `from`…`to` (a caret when `to` is omitted): select it,
 * center its first line, mark its lines for a moment and focus the editor —
 * once its surface is shown, if it is not yet. Positions are clamped to the
 * document, so a stale target still lands.
 */
export function revealInEditor(view: EditorView, target: { from: number; to?: number }) {
  const { length } = view.state.doc;
  const from = clamp(target.from, 0, length);
  const to = clamp(target.to ?? from, from, length);
  const marks = view.state.field(revealFlash, false) !== undefined;
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: [
      EditorView.scrollIntoView(from, { y: "center" }),
      ...(marks ? [setRevealFlash.of({ from, to })] : []),
    ],
  });
  focusWhenShown({ dom: view.dom, focus: () => view.focus(), hasFocus: () => view.hasFocus, alive: () => view.dom.isConnected });
  centerAgainOnceDrawn(view, from);
  if (!marks) return;
  window.clearTimeout(flashTimers.get(view));
  flashTimers.set(view, window.setTimeout(() => {
    flashTimers.delete(view);
    // Safe on a view destroyed meanwhile (a file switch remounts it): CodeMirror ignores it.
    view.dispatch({ effects: setRevealFlash.of(null) });
  }, REVEAL_FLASH_MS));
}

/**
 * How long after a jump the target is kept centered while its document is
 * drawn: past the flash's removal, whose redraw is the last that can move it.
 */
const SETTLE_MS = REVEAL_FLASH_MS + 400;
/** What the writer does to take the view elsewhere; a jump stops holding the target once they do. */
const WRITER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * CodeMirror scrolls to a target it has not drawn by the heights it estimated
 * for the lines above it, and drawing them corrects the estimate — more than
 * once, the last time well after the jump. A document swapped into a hidden
 * tab just before a jump (a comment opened in another file with reduced
 * motion) first scrolled tens of thousands of pixels past its quote, then lost
 * that height in steps that clamped it to the end of the file. So until the
 * drawing settles, every scroll the jump did not ask for and every change in
 * the content's height re-checks the target, and centers it again if it
 * moved — unless the writer has moved the selection or the view since.
 */
function centerAgainOnceDrawn(view: EditorView, from: number) {
  const landed = view.state.selection;
  const { scrollDOM, contentDOM } = view;
  const check = () => {
    if (!view.dom.isConnected || !view.state.selection.eq(landed)) return stop();
    const box = scrollDOM.getBoundingClientRect();
    const target = view.coordsAtPos(from);
    if (!target || box.height <= 0) return;
    const offset = (target.top + target.bottom) / 2 - (box.top + scrollDOM.clientHeight / 2);
    if (Math.abs(offset) > view.defaultLineHeight) view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  };
  const resized = new ResizeObserver(check);
  const timer = window.setTimeout(() => stop(), SETTLE_MS);
  function stop() {
    window.clearTimeout(timer);
    resized.disconnect();
    scrollDOM.removeEventListener("scroll", check);
    for (const type of WRITER_INPUT) view.dom.removeEventListener(type, stop, true);
  }
  scrollDOM.addEventListener("scroll", check);
  resized.observe(contentDOM);
  for (const type of WRITER_INPUT) view.dom.addEventListener(type, stop, true);
}

/** The 1-based `line` of `view`'s document as a caret target, clamped to the lines it has. */
export function lineTarget(view: EditorView, line: number) {
  return { from: view.state.doc.line(clamp(line, 1, view.state.doc.lines)).from };
}

/** The search panel's match placement: centered, like every other jump. */
export const centerMatch = (range: { from: number }) => EditorView.scrollIntoView(range.from, { y: "center" });
