/**
 * "Add comment" in the Lattice visual engine (spec R-SRC-7): the selection
 * stays marked while the comment is written and follows edits made meanwhile;
 * the comment is anchored in Markdown offsets; Escape or a click outside
 * closes the composer and keeps unsent words for the same passage.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AllSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(given: Partial<Props>) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  render(<LatticeVisualMarkdownEditor text="Hello" activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} {...given} />);
  return { onChange, get editor() { return surface().editor; } };
}

function select(editor: Editor, from: number, to = from) {
  act(() => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the comment composer (R-SRC-7)", () => {
  it.each([
    [false, "submit"], [true, "submit"], [false, "cancel"], [true, "escape"], [false, "outside"],
  ] as const)("marks the selection while a comment is written (pending edit: %s, then %s)", async (pendingEdit, action) => {
    const onCreateComment = vi.fn();
    const { editor } = renderEditor({ onCreateComment });
    select(editor, 1, 6);
    const button = await screen.findByRole("button", { name: "Comment" });
    if (pendingEdit) {
      act(() => {
        const transaction = editor.state.tr.insertText("New ", 1);
        transaction.setSelection(TextSelection.create(transaction.doc, 5, 10));
        editor.view.dispatch(transaction);
      });
    }
    fireEvent.click(button);
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    expect(surface().querySelector(".lx-md-comment-draft")?.textContent).toBe("Hello");
    if (action === "cancel") fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    else if (action === "escape") fireEvent.keyDown(within(composer).getByRole("textbox", { name: "Comment" }), { key: "Escape" });
    else if (action === "outside") fireEvent.pointerDown(surface());
    else {
      fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Please clarify this." } });
      fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
      expect(onCreateComment).toHaveBeenCalledWith(pendingEdit ? 4 : 0, pendingEdit ? 9 : 5, "Please clarify this.");
    }
    if (action !== "submit") expect(onCreateComment).not.toHaveBeenCalled();
    expect(surface().querySelector(".lx-md-comment-draft")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
  });

  it.each(["escape", "outside"] as const)("keeps an unsent comment closed by %s for the same passage; Cancel discards it", async (how) => {
    const { editor } = renderEditor({ text: "One Hello two", onCreateComment: vi.fn() });
    const open = async (from: number, to: number) => {
      select(editor, from, to);
      fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
      return within(await screen.findByRole("dialog", { name: "Add comment" })).getByRole("textbox", { name: "Comment" });
    };
    const close = (box: HTMLElement) => {
      if (how === "escape") fireEvent.keyDown(box, { key: "Escape" });
      else fireEvent.pointerDown(surface());
      expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
    };
    let box = await open(5, 10);
    fireEvent.change(box, { target: { value: "Half a thought" } });
    close(box);
    // Another passage starts empty and leaves the kept words alone.
    box = await open(1, 4);
    expect(box).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    box = await open(5, 10);
    expect(box).toHaveValue("Half a thought");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    box = await open(5, 10);
    expect(box).toHaveValue("");
  });

  it("follows edits made while the comment is written", async () => {
    const onCreateComment = vi.fn();
    const { editor } = renderEditor({ text: "One Hello two", onCreateComment });
    select(editor, 5, 10);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("New ", 1));
    });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Still here." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
    expect(onCreateComment).toHaveBeenCalledWith(8, 13, "Still here.");
  });

  it("refuses a selection whose text changed while the comment was written", async () => {
    const onCreateComment = vi.fn();
    const { editor } = renderEditor({ text: "One Hello two", onCreateComment });
    select(editor, 5, 10);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("a", 6, 7));
    });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Why?" } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
    expect(within(composer).getByRole("alert")).toHaveTextContent("The selected text changed. Select it again before commenting.");
    expect(onCreateComment).not.toHaveBeenCalled();
  });

  it.each([
    { text: "## Intro\n\nA paragraph\n- one\n- two\n\nText", whole: false },
    { text: "## Intro\r\n\r\nA paragraph\r\n- one\r\n- two\r\n\r\nText", whole: false },
    { text: "## Intro\n\nA paragraph\n- one\n- two\n\nText", whole: true },
  ])("anchors a comment in the source as written: %j", async ({ text, whole }) => {
    const onCreateComment = vi.fn();
    const { editor, onChange } = renderEditor({ text, onCreateComment });
    act(() => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(whole ? new AllSelection(editor.state.doc) : TextSelection.create(editor.state.doc, 8, 19)));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    const quote = whole ? text : "A paragraph";
    expect(composer.querySelector(".lx-md-comment-quote")?.textContent).toBe(quote);
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Clarify." } });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
    const from = whole ? 0 : text.indexOf("A paragraph");
    expect(onCreateComment).toHaveBeenCalledWith(from, from + quote.length, "Clarify.");
    expect(onChange).not.toHaveBeenCalled();
  });
});
