/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVisualEditorEngine, VISUAL_EDITOR_ENGINE_KEY } from "../../../settings/app-settings";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;
type ChangeMock = ReturnType<typeof vi.fn<Props["onChangeMarkdown"]>>;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(props: Partial<Props> = {}) {
  const onChange: ChangeMock = vi.fn<Props["onChangeMarkdown"]>(() => true);
  let current: Props = { text: "Hello", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true, ...props };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return {
    ...view,
    onChange: (props.onChangeMarkdown ?? onChange) as ChangeMock,
    rerender: (next: Partial<Props>) => view.rerender(<LatticeVisualMarkdownEditor {...(current = { ...current, ...next })} />),
    get editor() { return surface().editor; },
  };
}

/** Append `text` at the end of the text in top-level block `index`. */
function appendToBlock(editor: Editor, index: number, text: string) {
  let position = 0;
  editor.state.doc.forEach((node, offset, current) => {
    if (current === index) position = offset + node.nodeSize - 1;
  });
  editor.view.dispatch(editor.state.tr.insertText(text, position));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Lattice visual Markdown editor", () => {
  it("is off unless the setting chooses it", () => {
    expect(loadVisualEditorEngine()).toBe("ok");
    localStorage.setItem(VISUAL_EDITOR_ENGINE_KEY, "lattice");
    expect(loadVisualEditorEngine()).toBe("lattice");
    localStorage.setItem(VISUAL_EDITOR_ENGINE_KEY, "something-else");
    expect(loadVisualEditorEngine()).toBe("ok");
  });

  it("renders Markdown visually, keeps unmodelled source verbatim, and never writes on open", async () => {
    const { onChange } = renderEditor({ text: "# Title\n\n- one\n- two\n\n<Tabs mode=\"x\">\n\nBody\n\n</Tabs>\n" });
    expect(surface().querySelector("h1")?.textContent).toBe("Title");
    expect(surface().querySelectorAll("li")).toHaveLength(2);
    const raw = surface().querySelector("pre[data-lattice-raw='component']");
    expect(raw?.getAttribute("data-label")).toBe("Component");
    expect(raw?.textContent).toBe("<Tabs mode=\"x\">\n\nBody\n\n</Tabs>");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("publishes one edit and keeps every untouched byte", async () => {
    const text = "## Contents\n- one\n\nClosing prose.\n";
    const { editor, onChange } = renderEditor({ text });
    appendToBlock(editor, 2, "!");
    appendToBlock(editor, 2, "?");
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("## Contents\n- one\n\nClosing prose.!?\n", text);
  });

  it("keeps the BOM and CRLF envelope on edit", async () => {
    const text = "\uFEFF# Title\r\n\r\nBody\r\n";
    const { editor, onChange } = renderEditor({ text });
    appendToBlock(editor, 1, " text");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("\uFEFF# Title\r\n\r\nBody text\r\n", text));
  });

  it("declines a file with mixed line endings: read-only, with a notice, and no writes", async () => {
    const { onChange } = renderEditor({ text: "One\r\n\r\nTwo\n" });
    expect(await screen.findByText(/Visual editing is unavailable/)).toBeInTheDocument();
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect(surface().textContent).toContain("Two");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports eligibility to a host that places the notice itself", async () => {
    const onEligibilityChange = vi.fn();
    renderEditor({ text: "a\rb", onEligibilityChange });
    await waitFor(() => expect(onEligibilityChange).toHaveBeenLastCalledWith(expect.stringMatching(/unavailable/)));
    expect(screen.queryByText(/Visual editing is unavailable/)).toBeNull();
  });

  it("adopts canonical text from the host without publishing, and ignores its own echo", async () => {
    const view = renderEditor({ text: "First\n" });
    view.rerender({ text: "Second\n" });
    await waitFor(() => expect(surface().textContent).toBe("Second"));
    appendToBlock(view.editor, 0, " edit");
    await waitFor(() => expect(view.onChange).toHaveBeenCalledWith("Second edit\n", "Second\n"));
    const before = view.editor.state.doc;
    view.rerender({ text: "Second edit\n" });
    await settle();
    expect(view.editor.state.doc).toBe(before);
    expect(view.onChange).toHaveBeenCalledTimes(1);
  });

  it("delegates undo and redo to the host after publishing the pending edit", async () => {
    const onUndo = vi.fn(() => true);
    const onRedo = vi.fn(() => true);
    const { editor, onChange } = renderEditor({ text: "Hello\n", onUndo, onRedo });
    appendToBlock(editor, 0, "!");
    editor.commands.keyboardShortcut("Mod-z");
    expect(onChange).toHaveBeenCalledWith("Hello!\n", "Hello\n");
    expect(onUndo).toHaveBeenCalledTimes(1);
    editor.commands.keyboardShortcut("Mod-Shift-z");
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("publishes an edit made during a long IME composition once the composition ends", async () => {
    const { editor, onChange } = renderEditor({ text: "Hello\n" });
    fireEvent.compositionStart(surface());
    appendToBlock(editor, 0, " 世界");
    await settle();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(surface());
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Hello 世界\n", "Hello\n"));
  });

  it("hands the host a synchronous flush and withdraws it on unmount", () => {
    const registrations: ((() => boolean) | null)[] = [];
    const view = renderEditor({ text: "Hello\n", onFlushPendingChange: (flush) => registrations.push(flush) });
    appendToBlock(view.editor, 0, " world");
    expect(registrations[0]?.()).toBe(true);
    expect(view.onChange).toHaveBeenCalledWith("Hello world\n", "Hello\n");
    view.unmount();
    expect(registrations.at(-1)).toBeNull();
  });

  it("publishes a pending edit for the previous file when the path switches", async () => {
    const publishA = vi.fn<Props["onChangeMarkdown"]>(() => true);
    const publishB = vi.fn<Props["onChangeMarkdown"]>(() => true);
    const view = renderEditor({ text: "Alpha\n", activePath: "a.md", onChangeMarkdown: publishA });
    appendToBlock(view.editor, 0, " edit");
    view.rerender({ text: "Beta\n", activePath: "b.md", onChangeMarkdown: publishB });
    await waitFor(() => expect(surface().textContent).toBe("Beta"));
    expect(publishA).toHaveBeenCalledWith("Alpha edit\n", "Alpha\n");
    expect(publishB).not.toHaveBeenCalled();
  });

  it("rebases a rejected draft over a disjoint canonical edit", async () => {
    const onChangeMarkdown = vi.fn<Props["onChangeMarkdown"]>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const view = renderEditor({ text: "Alpha middle Omega\n", onChangeMarkdown });
    appendToBlock(view.editor, 0, " tail");
    await waitFor(() => expect(onChangeMarkdown).toHaveBeenCalledWith("Alpha middle Omega tail\n", "Alpha middle Omega\n"));
    view.rerender({ text: "Prefix Alpha middle Omega\n" });
    await waitFor(() => expect(onChangeMarkdown).toHaveBeenLastCalledWith("Prefix Alpha middle Omega tail\n", "Prefix Alpha middle Omega\n"));
    expect(surface().textContent).toBe("Prefix Alpha middle Omega tail");
  });

  it("keeps a read-only document read-only", () => {
    renderEditor({ text: "Hello\n", editable: false });
    expect(surface().getAttribute("contenteditable")).toBe("false");
  });
});
