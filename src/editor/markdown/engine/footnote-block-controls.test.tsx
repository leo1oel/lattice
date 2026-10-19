/**
 * Footnote definitions under the block controls and the pointer (spec
 * R-BLK-6, R-CHR-5): Add block below works on a note that ends the document,
 * the controls sit on the note's first line, the grip selects and drags a note
 * like any block, and a press beside a note or on its chrome puts the caret in
 * its text rather than a gap cursor or the next note.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke }));

type Props = VisualMarkdownEditorProps;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(text: string) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  render(<LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} />);
  return { onChange, get editor() { return surface().editor; } };
}

const setRect = (element: Element, rect: DOMRect) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
const types = (editor: Editor) => editor.state.doc.content.content.map((node) => node.type.name);
const NOTES = "Claim.[^a] Other.[^b]\n\n[^a]: First note.\n\n[^b]: Second note.";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("footnote block controls (R-BLK-6, R-CHR-5)", () => {
  it.each([
    ["a note", NOTES, "latticeFootnote"],
    ["a paragraph", "First\n\nLast", "paragraph"],
  ])("adds a slash line below %s that ends the document", async (_name, text, last) => {
    const { editor } = renderEditor(text);
    const blocks = [...surface().children];
    blocks.forEach((block, index) => setRect(block, new DOMRect(100, 100 + index * 40, 400, 28)));
    const final = blocks[blocks.length - 1]!;
    fireEvent.mouseMove(final, { clientX: 150, clientY: 100 + (blocks.length - 1) * 40 + 10 });
    fireEvent.click(await screen.findByRole("button", { name: "Add block below" }));
    expect(types(editor).slice(-2)).toEqual([last, "paragraph"]);
    expect(editor.state.doc.lastChild?.textContent).toBe("/");
    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
  });

  it("sits on a note's first line, below the rule that opens the run", async () => {
    const { editor } = renderEditor(NOTES);
    const blocks = [...surface().children];
    blocks.forEach((block, index) => setRect(block, new DOMRect(100, 100 + index * 60, 400, 50)));
    // The first note's text starts 24px into its box, under the rule's padding.
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation(() => ({ left: 130, right: 131, top: 184, bottom: 204 }));
    fireEvent.mouseMove(blocks[1]!, { clientX: 150, clientY: 190 });
    const controls = (await screen.findByRole("button", { name: "Add block below" })).parentElement!;
    expect(controls.style.top).toBe("182px");
    // Other blocks keep their box's top.
    fireEvent.mouseMove(blocks[0]!, { clientX: 150, clientY: 110 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add block below" }).parentElement!.style.top).toBe("100px"));
  });

  it("selects a note from its grip and drags it like any block", async () => {
    const { editor, onChange } = renderEditor(NOTES);
    const blocks = [...surface().children];
    setRect(surface(), new DOMRect(100, 100, 400, 170));
    [100, 160, 220].forEach((top, index) => setRect(blocks[index]!, new DOMRect(100, top, 400, 50)));
    fireEvent.mouseMove(blocks[2]!, { clientX: 150, clientY: 230 });
    const grip = await screen.findByRole("button", { name: "Select block" });
    fireEvent.pointerDown(grip, { button: 0, clientY: 230 });
    fireEvent.pointerUp(window, { clientY: 230 });
    expect((editor.state.selection as NodeSelection).node?.type.name).toBe("latticeFootnote");
    expect((editor.state.selection as NodeSelection).node?.attrs.label).toBe("b");
    fireEvent.mouseMove(blocks[2]!, { clientX: 150, clientY: 230 });
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Select block" }), { button: 0, clientY: 230 });
    fireEvent.pointerMove(window, { clientY: 158 });
    fireEvent.pointerUp(window, { clientY: 158 });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("Claim.[^a] Other.[^b]\n\n[^b]: Second note.\n\n[^a]: First note."));
  });
});

describe("pointer beside a footnote (R-BLK-6)", () => {
  const textEnd = (editor: Editor) => [editor.state.selection.$from.parent.textContent, editor.state.selection.$from.parentOffset];
  const click = (editor: Editor, position: number) => editor.view.someProp("handleClick", (handle) => handle(editor.view, position, new MouseEvent("click")));

  it("puts the caret at the end of the note above a click below or between notes, not a gap cursor", () => {
    const { editor } = renderEditor(NOTES);
    act(() => {
      expect(click(editor, editor.state.doc.content.size)).toBe(true);
    });
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(textEnd(editor)).toEqual(["Second note.", 12]);
    const between = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    act(() => {
      expect(click(editor, between)).toBe(true);
    });
    expect(textEnd(editor)).toEqual(["First note.", 11]);
  });

  it("leaves clicks between ordinary blocks to the editor", () => {
    const { editor } = renderEditor("First\n\nSecond");
    expect(click(editor, editor.state.doc.firstChild!.nodeSize)).toBeFalsy();
  });

  it.each([
    ["its number", ".lx-md-footnote-number"],
    ["its own box", ".lx-md-footnote"],
  ])("puts a press on %s into the note's text at that height", async (_name, selector) => {
    const { editor } = renderEditor(NOTES);
    const note = await screen.findByRole("complementary", { name: "Footnote a" });
    setRect(note.querySelector(".lx-md-footnote-body")!, new DOMRect(130, 120, 300, 40));
    let inside = -1;
    editor.state.doc.descendants((node, position) => {
      if (inside < 0 && node.isText && node.text === "First note.") inside = position + 3;
    });
    const probe = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: inside, inside: -1 });
    const target = selector === ".lx-md-footnote" ? note : note.querySelector(selector)!;
    const pressed = fireEvent.mouseDown(target, { button: 0, clientX: 110, clientY: 100 });
    expect(pressed).toBe(false);
    // Above the text, the probe goes inside the first line, at the body's leading edge.
    expect(probe).toHaveBeenCalledWith({ left: 131, top: 128 });
    expect(editor.state.selection.from).toBe(inside);
  });
});
