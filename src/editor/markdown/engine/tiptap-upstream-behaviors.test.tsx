/**
 * Tiptap's own editing behaviors as they reach the Lattice visual engine:
 * StarterKit's list keymap, core deleteSelection, the Table extension with
 * Lattice's attributes, and Suggestion's allowedPrefixes. Each case drives the
 * real editor through keys or typed text and asserts the Markdown it writes,
 * so a @tiptap/* upgrade that changes one of them fails here.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../../../app-types";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;
type ChangeMock = ReturnType<typeof vi.fn<Props["onChangeMarkdown"]>>;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(props: Partial<Props> | string = {}) {
  const onChange: ChangeMock = vi.fn<Props["onChangeMarkdown"]>(() => true);
  const given = typeof props === "string" ? { text: props } : props;
  const current: Props = { text: "", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true, ...given };
  render(<LatticeVisualMarkdownEditor {...current} />);
  return { onChange, get editor() { return surface().editor; } };
}

const lastChange = (onChange: ChangeMock) => String(onChange.mock.lastCall?.[0]);

function nodePos(editor: Editor, match: string | ((node: PmNode) => boolean)): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && (typeof match === "string" ? node.isText && node.text === match : match(node))) found = position;
    return found < 0;
  });
  return found;
}

function caret(editor: Editor, position: number, head = position) {
  act(() => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position, head)));
  });
}

function type(editor: Editor, text: string) {
  act(() => {
    for (const piece of text) {
      const { from, to } = editor.state.selection;
      const insert = () => editor.state.tr.insertText(piece, from, to);
      if (!editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, piece, insert))) editor.view.dispatch(insert());
    }
  });
}

const press = (key: string) => act(() => { fireEvent.keyDown(surface(), { key }); });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("list keymap (StarterKit ListKeymap)", () => {
  it("Backspace at the start of a second item lifts it out of the list", async () => {
    const { editor, onChange } = renderEditor("- one\n- two\n");
    caret(editor, nodePos(editor, "two"));
    press("Backspace");
    await waitFor(() => expect(lastChange(onChange)).toBe("- one\n\ntwo\n"));
  });

  it("Backspace at the start of a paragraph after a list joins it into the last item", async () => {
    const { editor, onChange } = renderEditor("- one\n- two\n\nafter\n");
    caret(editor, nodePos(editor, "after"));
    press("Backspace");
    await waitFor(() => expect(lastChange(onChange)).toBe("- one\n- twoafter\n"));
  });

  it("Delete at the end of a nested item joins the shallower next item into it", async () => {
    const { editor, onChange } = renderEditor("- a\n  - b\n- c\n");
    caret(editor, nodePos(editor, "b") + 1);
    press("Delete");
    await waitFor(() => expect(lastChange(onChange)).toBe("- a\n  - bc\n"));
  });

  it("Delete at the end of an item joins the next item into it", async () => {
    const { editor, onChange } = renderEditor("- one\n- two\n");
    caret(editor, nodePos(editor, "one") + 3);
    press("Delete");
    await waitFor(() => expect(lastChange(onChange)).toBe("- onetwo\n"));
  });

  it("Delete over a range spanning two items removes just that range", async () => {
    const { editor, onChange } = renderEditor("- one\n- two\n");
    caret(editor, nodePos(editor, "one") + 1, nodePos(editor, "two") + 2);
    press("Delete");
    await waitFor(() => expect(lastChange(onChange)).toBe("- oo\n"));
  });

  it("Backspace beside a citation chip in a list item still removes the chip whole", async () => {
    const papers = [{ arxivId: "1706.03762", title: "Attention", citationKey: "v2017", hasFullText: true, hasBlog: true }] as PaperSummary[];
    const { editor, onChange } = renderEditor({ text: "- see [Attention](.research/papers/1706.03762/paper.md)\n- two\n", papers });
    const chip = nodePos(editor, (node) => node.type.name === "latticeCitation");
    expect(chip).toBeGreaterThan(0);
    caret(editor, chip + 1);
    press("Backspace");
    await waitFor(() => expect(lastChange(onChange)).toMatch(/^- see ?\n- two\n$/));
  });
});

describe("deleteSelection", () => {
  it("keeps the deleted text's bold mark for the next typed character", async () => {
    const { editor, onChange } = renderEditor("a **bold** z");
    const start = nodePos(editor, "bold");
    caret(editor, start, start + 4);
    press("Backspace");
    type(editor, "X");
    await waitFor(() => expect(lastChange(onChange)).toBe("a **X** z"));
  });
});

describe("tables (Table with Lattice align/layout attrs, resizable: false)", () => {
  const TABLE = "| A | B |\n| :-- | --: |\n| 1 | 2 |\n";

  it("keeps column alignment through an attribute change and a cell edit", async () => {
    const { editor, onChange } = renderEditor(TABLE);
    const table = nodePos(editor, (node) => node.type.name === "table");
    const before = document.querySelector(".ProseMirror table");
    expect(before).not.toBeNull();
    expect(document.querySelector(".column-resize-handle")).toBeNull();
    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeAttribute(table, "align", ["center", "right"]));
    });
    expect(document.querySelectorAll(".ProseMirror table")).toHaveLength(1);
    caret(editor, nodePos(editor, "1") + 1);
    type(editor, "0");
    await waitFor(() => expect(lastChange(onChange)).toBe("| A | B |\n| :---: | ---: |\n| 10 | 2 |\n"));
  });
});

describe("suggestion allowedPrefixes [\" \"]", () => {
  const PAPERS = [{ arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "v2017", hasFullText: true, hasBlog: true }] as PaperSummary[];

  it("opens the citation menu after a space but not glued to a word", async () => {
    const { editor } = renderEditor({ text: "Before", papers: PAPERS });
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, "x@att");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole("listbox", { name: "Paper citation suggestions" })).toBeNull();
    type(editor, " @att");
    expect(await screen.findByRole("listbox", { name: "Paper citation suggestions" })).toBeInTheDocument();
  });
});
