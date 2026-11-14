/**
 * The writing surface's caret, drawn. WebKit sizes the native caret from the
 * run it sits in: a line of body text gave a short caret beside inline code
 * and a tall one in an empty paragraph or at a wrapped line's start, and its
 * 1px stroke in text ink was easy to lose. This caret takes its height from
 * the text block it is in (the block's font size, never more than its line),
 * so every line of a paragraph has the same caret and a heading's is scaled
 * to its type, and it is drawn and blinks like the source editor's
 * (`--editor-caret-width`, `--code-caret`, CodeMirror's 1.2s blink).
 *
 * It shows only for an empty text selection in the focused, editable surface;
 * otherwise (a range, a node or gap selection, IME composition, another
 * field) the native caret and selection paint as usual.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** A caret's height in its block's font size: about a line's ascent and descent. */
export const CARET_EM = 1.2;

type Coords = { top: number; bottom: number; left: number };
type Metrics = { fontSize: number; lineHeight: number };

/**
 * Where to draw the caret in its host: at the native caret's x, centered on
 * the line the native caret marks, as tall as the block's type allows.
 * Centering on the line keeps it put as it passes a run in another size
 * (inline code, a superscript), whose box shares the line's middle.
 */
export function caretPlacement(coords: Coords, host: { top: number; left: number }, block: Metrics): { top: number; left: number; height: number } {
  const lineHeight = Number.isFinite(block.lineHeight) && block.lineHeight > 0 ? block.lineHeight : block.fontSize * 1.2;
  const height = Math.min(block.fontSize * CARET_EM, lineHeight);
  const middle = (coords.top + coords.bottom) / 2;
  return { top: middle - height / 2 - host.top, left: coords.left - host.left, height };
}

/** The font metrics of the text block holding `position`. */
function blockMetrics(view: EditorView, position: number): Metrics | null {
  const $at = view.state.doc.resolve(position);
  const { node } = view.domAtPos($at.start());
  const element = node instanceof HTMLElement ? node : node.parentElement;
  if (!element) return null;
  const style = getComputedStyle(element);
  const fontSize = parseFloat(style.fontSize);
  return fontSize > 0 ? { fontSize, lineHeight: parseFloat(style.lineHeight) } : null;
}

class DrawnCaretView {
  private readonly caret: HTMLElement;
  private readonly host: HTMLElement;
  private readonly resize: ResizeObserver | null;
  private frame: number | null = null;
  private placed = "";
  private readonly schedule = () => {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = null;
      this.refresh();
    });
  };

  constructor(private readonly view: EditorView) {
    // The surface's parent: Tiptap's mount, outside ProseMirror's DOM and React's children.
    this.host = view.dom.parentElement ?? view.dom;
    this.host.setAttribute("data-lx-md-caret-host", "");
    this.caret = document.createElement("div");
    this.caret.className = "lx-md-caret";
    this.caret.setAttribute("aria-hidden", "true");
    this.caret.hidden = true;
    this.host.append(this.caret);
    for (const type of ["focus", "blur", "compositionstart", "compositionend"]) view.dom.addEventListener(type, this.schedule);
    // A code block or table scrolled sideways moves the text under the caret;
    // the panel's own scroller moves both together.
    view.dom.addEventListener("scroll", this.schedule, true);
    window.addEventListener("focus", this.schedule);
    window.addEventListener("blur", this.schedule);
    // Images loading, blocks drawn into the window above, a panel resized.
    this.resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(this.schedule);
    this.resize?.observe(view.dom);
    this.schedule();
  }

  update() {
    this.schedule();
  }

  destroy() {
    if (this.frame != null) cancelAnimationFrame(this.frame);
    for (const type of ["focus", "blur", "compositionstart", "compositionend"]) this.view.dom.removeEventListener(type, this.schedule);
    this.view.dom.removeEventListener("scroll", this.schedule, true);
    window.removeEventListener("focus", this.schedule);
    window.removeEventListener("blur", this.schedule);
    this.resize?.disconnect();
    this.view.dom.removeAttribute("data-drawn-caret");
    this.host.removeAttribute("data-lx-md-caret-host");
    this.caret.remove();
  }

  private hide() {
    this.view.dom.removeAttribute("data-drawn-caret");
    this.caret.hidden = true;
    this.placed = "";
  }

  private refresh() {
    const { view } = this;
    const { selection } = view.state;
    const shown = view.editable && !view.composing && document.hasFocus() && document.activeElement === view.dom
      && selection instanceof TextSelection && selection.empty;
    if (!shown) {
      this.hide();
      return;
    }
    let coords: Coords;
    try {
      coords = view.coordsAtPos(selection.head);
    } catch {
      this.hide();
      return;
    }
    const metrics = blockMetrics(view, selection.head);
    if (!metrics) {
      this.hide();
      return;
    }
    const place = caretPlacement(coords, this.host.getBoundingClientRect(), metrics);
    const key = `${place.left}:${place.top}:${place.height}`;
    view.dom.setAttribute("data-drawn-caret", "");
    this.caret.hidden = false;
    if (key === this.placed) return;
    this.placed = key;
    this.caret.style.transform = `translate(${place.left}px, ${place.top}px)`;
    this.caret.style.height = `${place.height}px`;
    // A caret that moved shows solid for a full beat before it blinks again.
    this.caret.style.animation = "none";
    void this.caret.offsetWidth;
    this.caret.style.animation = "";
  }
}

export const DrawnCaret = Extension.create({
  name: "latticeDrawnCaret",
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey("latticeDrawnCaret"), view: (view) => new DrawnCaretView(view) })];
  },
});
