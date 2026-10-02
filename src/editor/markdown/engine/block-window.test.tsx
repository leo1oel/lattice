/**
 * Viewport rendering of long documents (spec R-PERF-3), through the editor:
 * only the blocks near the viewport (and the selection's) are drawn, the
 * rest are placeholders of their size, and editing, selection, IME, find and
 * jumps work on the whole document.
 *
 * jsdom has no layout, so these tests stack the surface's blocks themselves:
 * a drawn block is 24px tall, a placeholder its own height.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;

const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

const VIEWPORT = 600;
const DRAWN_BLOCK = 24;

const paragraphs = (count: number, from = 0) => Array.from({ length: count }, (_, index) => `Paragraph ${from + index} of the long document.`);
const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const placeholders = () => surface().querySelectorAll(":scope > [data-lx-virtual]");
const drawn = () => [...surface().children].filter((child) => !child.hasAttribute("data-lx-virtual"));
const drawnText = () => drawn().map((child) => child.textContent ?? "").join("\n");

/** A scroller of VIEWPORT height whose surface stacks its children: the layout jsdom lacks. */
function layout(scroller: HTMLElement) {
  let scrollTop = 0;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, value); } });
  const box = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  const heightOf = (element: Element) => {
    if (!element.hasAttribute("data-lx-virtual")) return DRAWN_BLOCK;
    const style = (element as HTMLElement).style;
    return Number.parseFloat(style.height) + Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
  };
  const original = HTMLElement.prototype.getBoundingClientRect;
  const rectOf = (element: HTMLElement): DOMRect => {
    if (element === scroller) return box(0, VIEWPORT);
    const root = scroller.querySelector(".ProseMirror");
    if (!root || element === root || !root.contains(element)) return original.call(element);
    let block: Element = element;
    while (block.parentElement !== root) block = block.parentElement!;
    let top = -scrollTop;
    for (const child of root.children) {
      if (child === block) return box(top, heightOf(child));
      top += heightOf(child);
    }
    return box(0, 0);
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return rectOf(this);
  });
  return {
    scrollTo(top: number) {
      scrollTop = Math.max(0, top);
      fireEvent.scroll(scroller);
    },
    get scrollTop() {
      return scrollTop;
    },
  };
}

function renderLong(text: string, props: Partial<Props> = {}) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  const host = document.createElement("div");
  host.className = "editor-doc-scroll";
  document.body.append(host);
  const geometry = layout(host);
  render(<LatticeVisualMarkdownEditor text={text} activePath="long.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} {...props} />, { container: host });
  return { onChange, geometry, host };
}

/** The first frame's window check, and the load the editor defers to a microtask. */
const loaded = async () => {
  await waitFor(() => expect(placeholders().length).toBeGreaterThan(0));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};

beforeEach(() => {
  // A browser: the window needs real layout, which tests stand in for.
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("viewport rendering of a long document (R-PERF-3)", () => {
  it("draws only the blocks near the viewport, and keeps the rest as placeholders", async () => {
    renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    expect(surface().children).toHaveLength(400);
    expect(drawn().length).toBeGreaterThan(VIEWPORT / DRAWN_BLOCK);
    expect(drawn().length).toBeLessThan(150);
    expect(drawnText()).toContain("Paragraph 0 of");
    expect(drawnText()).not.toContain("Paragraph 399 of");
    // A placeholder has a size, so the document is as tall as it will be drawn.
    expect(Number.parseFloat((placeholders()[0] as HTMLElement).style.height)).toBeGreaterThan(0);
  });

  it("estimates a long paragraph that is not drawn at its wrapped lines, not one line", async () => {
    renderLong([...paragraphs(399), "A long paragraph. ".repeat(100)].join("\n\n"));
    await loaded();
    const heightOf = (element: Element) => Number.parseFloat((element as HTMLElement).style.height);
    const short = heightOf(placeholders()[0]!);
    expect(heightOf(surface().children[399]!)).toBeGreaterThan(5 * short);
  });

  it("draws a small document whole", async () => {
    renderLong(paragraphs(120).join("\n\n"));
    await waitFor(() => expect(surface().children).toHaveLength(120));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(placeholders()).toHaveLength(0);
  });

  it("draws the blocks it scrolls to and releases the ones it leaves, keeping the reader's place", async () => {
    const { geometry } = renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    const top = (index: number) => {
      const block = surface().children[index] as HTMLElement;
      return block.getBoundingClientRect().top;
    };
    geometry.scrollTo(top(200) + geometry.scrollTop);
    const before = top(200);
    // The scroll drew the blocks in view and let the first ones go (the caret's block stays).
    expect(surface().children[200]).not.toHaveAttribute("data-lx-virtual");
    expect(surface().children[10]).toHaveAttribute("data-lx-virtual");
    expect(surface().children[0]).not.toHaveAttribute("data-lx-virtual");
    expect(drawnText()).toContain("Paragraph 200 of");
    // The block in view stayed where it was on screen while blocks around it changed size.
    expect(Math.abs(top(200) - before)).toBeLessThan(DRAWN_BLOCK);
    expect(drawn().length).toBeLessThan(150);
  });

  it("keeps the whole document: an edit publishes the complete file", async () => {
    const text = paragraphs(400).join("\n\n");
    const { onChange } = renderLong(text);
    await loaded();
    const { editor } = surface();
    let end = 0;
    editor.state.doc.forEach((node, offset, index) => {
      if (index === 0) end = offset + node.nodeSize - 1;
    });
    editor.view.dispatch(editor.state.tr.insertText("!", end));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(onChange.mock.calls[0]![0]).toBe(text.replace("Paragraph 0 of the long document.", "Paragraph 0 of the long document.!"));
  });

  it("draws the selection's block, and the blocks either side of it, wherever the view is", async () => {
    renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    const { editor } = surface();
    let inLast = 0;
    editor.state.doc.forEach((_node, offset, index) => {
      if (index === 398) inLast = offset + 2;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, inLast)));
    const blocks = surface().children;
    expect(blocks[398]).not.toHaveAttribute("data-lx-virtual");
    expect(blocks[397]).not.toHaveAttribute("data-lx-virtual");
    expect(blocks[399]).not.toHaveAttribute("data-lx-virtual");
    expect(blocks[300]).toHaveAttribute("data-lx-virtual");
    // Typing there edits the drawn block.
    editor.view.dispatch(editor.state.tr.insertText("typed "));
    expect(blocks[398]?.textContent).toContain("typed ");
  });

  it("draws every block again when the document becomes short", async () => {
    renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    const { editor } = surface();
    let cut = 0;
    editor.state.doc.forEach((_node, offset, index) => {
      if (index === 200) cut = offset;
    });
    editor.view.dispatch(editor.state.tr.delete(cut, editor.state.doc.content.size));
    expect(surface().children).toHaveLength(200);
    expect(placeholders()).toHaveLength(0);
    expect(drawnText()).toContain("Paragraph 199 of");
  });

  it("moves the caret to the end of the document past the blocks not drawn, and draws it", async () => {
    renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    const { editor } = surface();
    fireEvent.keyDown(surface(), { key: "End", ctrlKey: true });
    expect(editor.state.selection.head).toBe(editor.state.doc.content.size - 1);
    expect(surface().children[399]).not.toHaveAttribute("data-lx-virtual");
    expect(surface().children[399]?.textContent).toContain("Paragraph 399 of");
    fireEvent.keyDown(surface(), { key: "Home", ctrlKey: true, shiftKey: true });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.anchor).toBe(editor.state.doc.content.size - 1);
  });

  it("leaves the drawn blocks alone during an IME composition", async () => {
    const { geometry } = renderLong(paragraphs(400).join("\n\n"));
    await loaded();
    fireEvent.compositionStart(surface());
    geometry.scrollTo(4000);
    expect(drawnText()).toContain("Paragraph 10 of");
    fireEvent.compositionEnd(surface());
    geometry.scrollTo(4000);
    expect(drawnText()).not.toContain("Paragraph 10 of");
  });

  it("finds a match in a block that is not drawn, and draws it", async () => {
    renderLong([...paragraphs(399), "The needle sits at the very end."].join("\n\n"));
    await loaded();
    fireEvent.keyDown(surface(), { key: "f", ctrlKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.change(input, { target: { value: "needle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(surface().children[399]).not.toHaveAttribute("data-lx-virtual"));
    expect(surface().children[399]?.textContent).toContain("needle");
  });

  it("lands a jump on an anchor in a block that is not drawn yet", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => undefined);
    renderLong(["[To the appendix](#appendix) first.", ...paragraphs(398), '<a id="appendix"></a>', "Appendix text."].join("\n\n"));
    await loaded();
    // The anchor is findable while its block is a placeholder.
    const placeholder = document.getElementById("appendix")!;
    expect(placeholder.closest("[data-lx-virtual]")).not.toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "To the appendix" }));
    // The jump draws the anchor's block first, then lands on it.
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    const target = scrollIntoView.mock.contexts[0] as HTMLElement;
    expect(target.isConnected).toBe(true);
    expect(target.closest("[data-lx-virtual]")).toBeNull();
    await waitFor(() => expect(target.querySelector("#appendix") ?? (target.id === "appendix" ? target : null)).not.toBeNull());
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it("gives a heading that is not drawn its id, inside a component too, so the section rail can reach it", async () => {
    renderLong([...paragraphs(390), "## Far section", "<Callout>\n## Inner section\n\nBody.\n</Callout>", ...paragraphs(9, 390)].join("\n\n"));
    await loaded();
    expect(document.getElementById("far-section")).toHaveAttribute("data-lx-virtual");
    const inner = document.getElementById("inner-section")!;
    expect(inner.closest("[data-lx-virtual]")).not.toBeNull();
  });
});
