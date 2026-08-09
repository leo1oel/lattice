import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export const visualFixedCaretKey = new PluginKey("visualFixedCaret");

/** Matches source-editor line metrics: 14px reading size × 1.6 ≈ 22px. */
export const VISUAL_FIXED_CARET_HEIGHT_PX = 22;

export type CaretCoords = {
  top: number;
  bottom: number;
  left: number;
};

export type CaretRootRect = {
  top: number;
  left: number;
};

export type VisualCaretScrollRefresh = "frame" | "settle";

/**
 * Inner overflow moves the native caret relative to our outer overlay and
 * needs the next frame. Scrolling an ancestor moves both together, so doing
 * synchronous geometry work every frame is redundant; one settled correction
 * is enough for late content materialization and scroll anchoring.
 */
export function visualCaretScrollRefresh(
  editorDom: HTMLElement,
  target: EventTarget | null,
): VisualCaretScrollRefresh {
  return target instanceof Node && editorDom.contains(target) ? "frame" : "settle";
}

/**
 * Place a fixed-height caret inside the native caret line box, vertically
 * centered so headings do not stretch it.
 */
export function visualFixedCaretPlacement(
  coords: CaretCoords,
  rootRect: CaretRootRect,
  height = VISUAL_FIXED_CARET_HEIGHT_PX,
): { top: number; left: number; height: number } {
  const lineHeight = Math.max(0, coords.bottom - coords.top);
  const caretHeight = lineHeight > 0 ? Math.min(height, lineHeight) : height;
  const top = coords.top - rootRect.top + Math.max(0, (lineHeight - caretHeight) / 2);
  return {
    top,
    left: coords.left - rootRect.left,
    height: caretHeight,
  };
}

function caretHost(view: EditorView): HTMLElement {
  return view.dom.closest<HTMLElement>(".visual-markdown-editor")
    ?? view.dom.parentElement
    ?? view.dom;
}

class FixedCaretPluginView {
  private readonly caret: HTMLElement;
  private readonly host: HTMLElement;
  private movingTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private raf: number | null = null;
  private lastPlacement = "";
  private readonly onFocusChange = () => this.scheduleRefresh();
  private readonly onResize = () => this.scheduleRefresh();
  private readonly onScroll = (event: Event) => {
    if (visualCaretScrollRefresh(this.view.dom, event.target) === "frame") {
      this.scheduleRefresh();
      return;
    }
    if (this.scrollSettleTimer != null) clearTimeout(this.scrollSettleTimer);
    this.scrollSettleTimer = setTimeout(() => {
      this.scrollSettleTimer = null;
      this.scheduleRefresh();
    }, 120);
  };

  constructor(private readonly view: EditorView) {
    this.host = caretHost(view);
    if (getComputedStyle(this.host).position === "static") {
      this.host.dataset.visualFixedCaretHost = "true";
    }
    this.caret = document.createElement("div");
    this.caret.className = "visual-fixed-caret";
    this.caret.setAttribute("aria-hidden", "true");
    this.caret.hidden = true;
    this.host.append(this.caret);
    view.dom.addEventListener("focus", this.onFocusChange);
    view.dom.addEventListener("blur", this.onFocusChange);
    view.dom.addEventListener("compositionstart", this.onFocusChange);
    view.dom.addEventListener("compositionend", this.onFocusChange);
    // Outer preview scrollports move the host without a PM transaction.
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("resize", this.onResize);
    this.refresh();
  }

  update() {
    this.scheduleRefresh();
  }

  destroy() {
    if (this.movingTimer != null) clearTimeout(this.movingTimer);
    if (this.scrollSettleTimer != null) clearTimeout(this.scrollSettleTimer);
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.view.dom.removeEventListener("focus", this.onFocusChange);
    this.view.dom.removeEventListener("blur", this.onFocusChange);
    this.view.dom.removeEventListener("compositionstart", this.onFocusChange);
    this.view.dom.removeEventListener("compositionend", this.onFocusChange);
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("resize", this.onResize);
    this.view.dom.removeAttribute("data-fixed-caret");
    delete this.host.dataset.visualFixedCaretHost;
    this.caret.remove();
  }

  private scheduleRefresh() {
    if (this.raf != null) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.refresh();
    });
  }

  private refresh() {
    const { view } = this;
    const { selection } = view.state;
    const show = view.editable
      && view.hasFocus()
      && !view.composing
      && selection instanceof TextSelection
      && selection.empty;

    view.dom.toggleAttribute("data-fixed-caret", show);
    if (!show) {
      this.caret.hidden = true;
      this.lastPlacement = "";
      return;
    }

    let coords: CaretCoords;
    try {
      coords = view.coordsAtPos(selection.head);
    } catch {
      this.caret.hidden = true;
      return;
    }

    const rootRect = this.host.getBoundingClientRect();
    const placement = visualFixedCaretPlacement(coords, rootRect);
    const next = `${placement.left}:${placement.top}:${placement.height}`;
    if (next !== this.lastPlacement) {
      this.lastPlacement = next;
      this.caret.style.left = `${placement.left}px`;
      this.caret.style.top = `${placement.top}px`;
      this.caret.style.height = `${placement.height}px`;
      this.markMoving();
    }
    this.caret.hidden = false;
  }

  private markMoving() {
    this.caret.dataset.moving = "";
    if (this.movingTimer != null) clearTimeout(this.movingTimer);
    this.movingTimer = setTimeout(() => {
      this.movingTimer = null;
      delete this.caret.dataset.moving;
    }, 100);
  }
}

export const VisualFixedCaret = Extension.create({
  name: "visualFixedCaret",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: visualFixedCaretKey,
        view(editorView) {
          return new FixedCaretPluginView(editorView);
        },
      }),
    ];
  },
});
