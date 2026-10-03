import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useMarkdownSplitScroll } from "./use-markdown-split-scroll";

afterEach(cleanup);

function setMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
}

describe("useMarkdownSplitScroll", () => {
  it("lines the source's last text up with the preview's end, not its scroll-past-end padding", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "first\nsecond\nlast" }), parent: document.body });
    // 1000px of range, 400px of it the padding below the last line.
    setMetrics(view.scrollDOM, 1500, 500);
    Object.defineProperty(view, "documentPadding", { configurable: true, value: { top: 0, bottom: 400 } });
    const preview = document.createElement("div");
    document.body.append(preview);
    setMetrics(preview, 900, 300);
    renderHook(() => useMarkdownSplitScroll({
      view: new WeakRef(view), preview: new WeakRef(preview), active: true, previewStart: 0, peerScrollSettleMs: 0,
      suppressedRef: { current: false }, viewportLockRef: { current: 0 },
      cursorRevealRef: { current: null }, reconcileRef: { current: null },
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    preview.scrollTop = 600;
    preview.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(view.scrollDOM.scrollTop).toBe(600));
    view.destroy();
    preview.remove();
  });
});
