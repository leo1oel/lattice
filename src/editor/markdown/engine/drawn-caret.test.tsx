/**
 * The drawn caret (drawn-caret.ts): one height for every line of a block
 * type, scaled with the type, centred on the line the native caret marks; and
 * the native caret back wherever the drawn one does not show.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CARET_EM, caretPlacement } from "./drawn-caret";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke }));

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const caret = () => document.querySelector<HTMLElement>(".lx-md-caret")!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("caretPlacement", () => {
  it("sizes the caret from the block's type, whatever run the native caret sits in", () => {
    const block = { fontSize: 16, lineHeight: 27 };
    // A plain run, an inline-code run and an empty line's full line box.
    const runs = [{ top: 104, bottom: 123, left: 10 }, { top: 106, bottom: 121, left: 40 }, { top: 100, bottom: 127, left: 0 }];
    const placed = runs.map((run) => caretPlacement(run, { top: 0, left: 0 }, block));
    expect(new Set(placed.map((place) => place.height))).toEqual(new Set([16 * CARET_EM]));
    // All three share the line's middle, so the caret does not hop between them.
    expect(new Set(placed.map((place) => place.top + place.height / 2))).toEqual(new Set([113.5]));
  });

  it("scales with a heading's size but never outgrows its line", () => {
    expect(caretPlacement({ top: 0, bottom: 30, left: 0 }, { top: 0, left: 0 }, { fontSize: 22.4, lineHeight: 29.1 }).height).toBeCloseTo(22.4 * CARET_EM);
    expect(caretPlacement({ top: 0, bottom: 30, left: 0 }, { top: 0, left: 0 }, { fontSize: 30, lineHeight: 33 }).height).toBe(33);
    // "normal" line height reads as NaN: the type's own size bounds it.
    expect(caretPlacement({ top: 0, bottom: 20, left: 0 }, { top: 0, left: 0 }, { fontSize: 16, lineHeight: Number.NaN }).height).toBeCloseTo(16 * CARET_EM);
  });

  it("measures from its host", () => {
    expect(caretPlacement({ top: 120, bottom: 140, left: 80 }, { top: 100, left: 50 }, { fontSize: 10, lineHeight: 20 })).toEqual({ top: 24, left: 30, height: 12 });
  });
});

describe("the drawn caret in the editor", () => {
  function renderFocused(text: string) {
    render(<LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />);
    const { editor } = surface();
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computed(element);
      if (element instanceof HTMLElement && element.matches("p")) Object.assign(style, { fontSize: "16px", lineHeight: "27px" });
      if (element instanceof HTMLElement && element.matches("h2")) Object.assign(style, { fontSize: "22px", lineHeight: "29px" });
      return style;
    });
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation(() => ({ left: 40, right: 41, top: 100, bottom: 120 }));
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => editor.view.focus());
    return editor;
  }
  const place = (editor: Editor, at: number) => act(() => {
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
  });

  it("stands in for the native caret at an empty selection, sized by its block", async () => {
    const editor = renderFocused("## Title\n\nBody text");
    place(editor, 3);
    await waitFor(() => expect(caret().hidden).toBe(false));
    expect(surface()).toHaveAttribute("data-drawn-caret");
    expect(caret().style.height).toBe(`${22 * CARET_EM}px`);
    place(editor, editor.state.doc.content.size - 2);
    await waitFor(() => expect(caret().style.height).toBe(`${16 * CARET_EM}px`));
  });

  it("gives the native caret and selection back for a range and when the surface loses focus", async () => {
    const editor = renderFocused("Body text");
    place(editor, 2);
    await waitFor(() => expect(caret().hidden).toBe(false));
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 5)));
    });
    await waitFor(() => expect(caret().hidden).toBe(true));
    expect(surface()).not.toHaveAttribute("data-drawn-caret");
    place(editor, 2);
    await waitFor(() => expect(caret().hidden).toBe(false));
    act(() => editor.view.dom.blur());
    await waitFor(() => expect(caret().hidden).toBe(true));
  });
});
