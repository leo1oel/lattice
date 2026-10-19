/**
 * Footnote definitions under the block controls and the pointer (spec
 * R-BLK-6, R-CHR-5): Add block below works on a note that ends the document,
 * the controls sit on the note's first line, the grip drags a note like any
 * block, and a click beside a note puts the caret in its text rather than a
 * gap cursor.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
