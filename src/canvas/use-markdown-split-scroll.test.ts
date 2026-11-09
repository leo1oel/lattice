import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { holdScroll } from "../editor/markdown/engine/viewport-anchor";
import { useMarkdownSplitScroll } from "./use-markdown-split-scroll";

afterEach(cleanup);

function setMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
}

describe("useMarkdownSplitScroll", () => {
  it("lines the source's last text up with the preview's end, not the padding below it", async () => {
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

  it("leaves the source where it is when the preview only held the reader's place", async () => {
    const view = new EditorView({ state: EditorState.create({ doc: "first\nsecond\nlast" }), parent: document.body });
    setMetrics(view.scrollDOM, 1500, 500);
    const preview = document.createElement("div");
    document.body.append(preview);
    setMetrics(preview, 1500, 500);
    renderHook(() => useMarkdownSplitScroll({
      view: new WeakRef(view), preview: new WeakRef(preview), active: true, previewStart: 0, peerScrollSettleMs: 0,
      suppressedRef: { current: false }, viewportLockRef: { current: 0 },
      cursorRevealRef: { current: null }, reconcileRef: { current: null },
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // An image above the viewport was released: the preview scrolled to keep its text still.
    holdScroll(preview, 240);
    preview.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(view.scrollDOM.scrollTop).toBe(0);
    // The reader's own scroll still leads.
    preview.scrollTop = 600;
    preview.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(view.scrollDOM.scrollTop).toBeGreaterThan(0));
    view.destroy();
    preview.remove();
  });

  it("leaves the preview where it is when the source only kept its place as lines landed above it", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `Line ${index} of the note.`);
    const view = new EditorView({ state: EditorState.create({ doc: lines.join("\n") }), parent: document.body });
    setMetrics(view.scrollDOM, 5000, 500);
    // jsdom lays nothing out: the content moves up as the source scrolls.
    vi.spyOn(view.contentDOM, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, -view.scrollDOM.scrollTop, 600, 5000));
    const preview = document.createElement("div");
    document.body.append(preview);
    setMetrics(preview, 5000, 500);
    renderHook(() => useMarkdownSplitScroll({
      view: new WeakRef(view), preview: new WeakRef(preview), active: true, previewStart: 0, peerScrollSettleMs: 0,
      suppressedRef: { current: false }, viewportLockRef: { current: 0 },
      cursorRevealRef: { current: null }, reconcileRef: { current: null },
    }));
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(100).from).top;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(preview.scrollTop).toBeGreaterThan(0));
    const followed = preview.scrollTop;

    // An agent writes three lines at the top; CodeMirror scrolls by their height to keep line 100 at the top.
    const before = view.lineBlockAt(view.state.doc.line(100).from).top;
    view.dispatch({ changes: { from: 0, insert: "Added.\nAdded.\nAdded.\n" } });
    view.scrollDOM.scrollTop += view.lineBlockAt(view.state.doc.line(103).from).top - before;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    await frame();
    expect(preview.scrollTop).toBe(followed);

    // The reader's own scroll in the source still leads.
    view.scrollDOM.scrollTop += 600;
    view.scrollDOM.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(preview.scrollTop).toBeGreaterThan(followed));
    view.destroy();
    preview.remove();
  });
});
