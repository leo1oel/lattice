/**
 * A paper dragged from the GPUI app's Papers list over an island's page.
 * GPUI's drag never becomes WebKit's, so the host hands its moves and its
 * drop over (`md:paper-drag`, or `tex:paper-drag` on a `.tex` file's Visual
 * page), and they are replayed here as the Tauri app's native bridge
 * replays Tauri's (`src/papers/paper-drop-bridge.ts`): each move as a
 * `dragover` on the element under the point, so the editor's drop cursor
 * follows it, a `dragleave` where it left, and the drop as a `drop` carrying
 * the paper's identity, which the editor's own paper drop resolves against
 * its library: the Markdown editor's (`references.tsx`'s `paperDropExtension`)
 * as an `@key` citation at the pointer, the LaTeX source's
 * (`src/editor/paper-drop.ts`) as `~\citep{key}` after the word there.
 */
import { PAPER_DRAG_TYPE, type PaperDrag } from "../../../src/papers/paper-drag";

export type PaperDragMessage = {
  phase: "over" | "leave" | "drop";
  /** In the page's pixels, from its top left. */
  x: number;
  y: number;
  paper: PaperDrag | null;
};

function paperTransfer(paper: PaperDrag) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(paper));
  return dataTransfer;
}

/** The replay of one drag after another: what it was over is its state. */
export function paperDragReplay() {
  let overTarget: Element | null = null;
  const leave = (next: Element | null) => {
    if (overTarget && overTarget !== next) {
      overTarget.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: next }));
    }
    overTarget = next;
  };
  return ({ phase, x, y, paper }: PaperDragMessage) => {
    if (phase === "leave" || !paper) {
      leave(null);
      return;
    }
    const target = document.elementFromPoint(x, y);
    const init = { bubbles: true, cancelable: true, dataTransfer: paperTransfer(paper), clientX: x, clientY: y };
    if (phase === "over") {
      leave(target);
      target?.dispatchEvent(new DragEvent("dragover", init));
      return;
    }
    // The drop target clears its own drop cursor.
    leave(target);
    overTarget = null;
    target?.dispatchEvent(new DragEvent("drop", init));
  };
}
