import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Props = VisualMarkdownEditorProps;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const bar = () => screen.queryByRole("search", { name: "Find in document" });
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function openReplace(text: string) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  render(<LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} />);
  const { editor } = surface();
  act(() => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, 4)));
  });
  fireEvent.keyDown(surface(), { key: "f", altKey: true, ctrlKey: true });
  const find = await screen.findByRole("searchbox", { name: "Find" });
  await waitFor(() => expect(within(bar()!).getByRole("status")).toHaveTextContent("1 of 2"));
  return { find, replace: screen.getByRole("textbox", { name: "Replace with" }), onChange };
}

// WebKit sends the Enter that commits a candidate right after compositionend,
// with isComposing false and keyCode 229. In "Replace with" that Enter once
// replaced the match with half-typed pinyin, and an Escape that only dropped
// the candidates closed the whole bar.
describe("Markdown find and replace with an input method", () => {
  it("leaves Enter and Escape in Replace with to the candidates", async () => {
    const { replace, onChange } = await openReplace("one two one");
    fireEvent.compositionStart(replace);
    fireEvent.change(replace, { target: { value: "san" } });
    fireEvent.keyDown(replace, { key: "Escape" });
    fireEvent.keyDown(replace, { key: "Enter", keyCode: 229 });
    expect(bar()).not.toBeNull();

    fireEvent.change(replace, { target: { value: "三" } });
    fireEvent.compositionEnd(replace);
    fireEvent.keyDown(replace, { key: "Enter", keyCode: 13 });
    expect(onChange).not.toHaveBeenCalled();

    await settle();
    fireEvent.keyDown(replace, { key: "Enter", keyCode: 13 });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("三 two one"));
    fireEvent.keyDown(replace, { key: "Escape" });
    expect(bar()).toBeNull();
  });

  it("leaves the commit Enter in Find to the candidates", async () => {
    const { find } = await openReplace("one two one");
    fireEvent.compositionStart(find);
    fireEvent.compositionEnd(find);
    fireEvent.keyDown(find, { key: "Enter", keyCode: 13 });
    expect(within(bar()!).getByRole("status")).toHaveTextContent("1 of 2");
    await settle();
    fireEvent.keyDown(find, { key: "Enter", keyCode: 13 });
    expect(within(bar()!).getByRole("status")).toHaveTextContent("2 of 2");
  });
});
