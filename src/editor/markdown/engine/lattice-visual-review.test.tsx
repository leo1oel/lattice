/**
 * The Lattice visual engine against the Markdown source (spec R-SRC-1–12):
 * the caret in source coordinates, collaborators' carets, comments and their
 * composer, tracked changes, View in source, and the selection as Markdown.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import { AllSelection, NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorComment } from "../../comments/editor-comment-data";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";

type Props = VisualMarkdownEditorProps;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(given: Partial<Props> | string = {}) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  let current: Props = {
    text: "Hello", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true,
    ...(typeof given === "string" ? { text: given } : given),
  };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return {
    ...view,
    onChange: current.onChangeMarkdown as typeof onChange,
    get editor() { return surface().editor; },
    rerender: (next: Partial<Props>) => {
      current = { ...current, ...next };
      view.rerender(<LatticeVisualMarkdownEditor {...current} />);
    },
  };
}

function nodePos(editor: Editor, match: string | ((node: PmNode) => boolean)): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && (typeof match === "string" ? node.isText && node.text === match : match(node))) found = position;
    return found < 0;
  });
  return found;
}

function select(editor: Editor, from: number, to = from) {
  act(() => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
  });
}

const ada = (row: number, column: number) => ({ name: "Ada", hue: 210, row, column });
const peerCaret = () => document.querySelector<HTMLElement>(".lx-md-peer-caret");
const setRect = (element: Element, rect: Partial<DOMRect>) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}), ...rect } as DOMRect);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the caret in Markdown (R-SRC-1)", () => {
  it.each([
    ["# Hello", "Hello", 2, [0, 4]],
    ["A\r\n\r\nB\r\n", "B", 1, [2, 1]],
    ['<Callout title="Exact">\n  Body\n</Callout>', "Body", 2, [1, 4]],
  ] as const)("reports a caret in %j", (text, node, offset, [row, column]) => {
    const onCaretChange = vi.fn();
    const { editor } = renderEditor({ text, onCaretChange });
    select(editor, nodePos(editor, node) + offset);
    expect(onCaretChange).toHaveBeenLastCalledWith(row, column);
  });

  it("follows marks, nesting and emoji, and a typed edit once it is published", async () => {
    const onCaretChange = vi.fn();
    const { editor } = renderEditor({ text: "**bold**\n\n- one\n- two 😀", onCaretChange });
    select(editor, nodePos(editor, "bold") + 2);
    expect(onCaretChange).toHaveBeenLastCalledWith(0, 4);
    select(editor, nodePos(editor, "two 😀") + "two 😀".length);
    expect(onCaretChange).toHaveBeenLastCalledWith(3, 8);
    act(() => {
      editor.commands.insertContent("!");
    });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(3, 9));
  });
});

describe("collaborators' carets (R-SRC-2, R-SRC-3)", () => {
  it("draws a labelled caret in the collaborator's color", async () => {
    renderEditor({ text: "# Hello", presenceCursors: [{ ...ada(0, 4), color: "#0E7490" }] });
    await waitFor(() => expect(peerCaret()).toHaveTextContent("Ada"));
    expect(peerCaret()!.style.getPropertyValue("--lx-md-peer-color")).toBe("#0E7490");
    expect(peerCaret()!.previousSibling).toHaveTextContent("He");
  });

  it("draws and moves a caret inside code", async () => {
    const { rerender } = renderEditor({ text: "```js\nconst value = 1\n```", presenceCursors: [ada(1, 5)] });
    // Highlighting splits code into spans: read the code's text before the caret.
    const before = () => {
      const range = document.createRange();
      range.selectNodeContents(peerCaret()!.closest("code")!);
      range.setEndBefore(peerCaret()!);
      return range.toString();
    };
    await waitFor(() => expect(peerCaret()?.closest("code")).not.toBeNull());
    expect(before()).toBe("const");
    rerender({ presenceCursors: [ada(1, 11)] });
    await waitFor(() => expect(before()).toBe("const value"));
  });

  it.each([
    ["an opening fence", "```js\nconst value = 1\n```", 0, 1],
    ["a closing fence", "```js\nconst value = 1\n```", 2, 1],
    ["an image", "![Alt](image.png)", 0, 10],
  ])("draws nothing on %s", async (_label, text, row, column) => {
    renderEditor({ text, presenceCursors: [ada(row, column)] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peerCaret()).toBeNull();
  });

  it("lands after the visible hash of a heading that starts with one", async () => {
    renderEditor({ text: "# # Title", presenceCursors: [ada(0, 3)] });
    await waitFor(() => expect(peerCaret()?.closest("h1")).not.toBeNull());
    expect(peerCaret()!.previousSibling).toHaveTextContent("#");
  });

  it("is placed again in canonical text that replaced the document", async () => {
    const { rerender } = renderEditor({ text: "First", presenceCursors: [ada(0, 4)] });
    await waitFor(() => expect(peerCaret()?.previousSibling).toHaveTextContent("Firs"));
    rerender({ text: "Second" });
    await waitFor(() => expect(peerCaret()?.previousSibling).toHaveTextContent("Seco"));
  });

  it("keeps its place after an inferred paper table, and draws nothing in a merged-away cell", async () => {
    const text = "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n\nAfter table";
    const { rerender } = renderEditor({ text, activePath: ".research/papers/2401.00001/paper.md", optimizeForReading: true, presenceCursors: [ada(4, 5)] });
    await waitFor(() => expect(peerCaret()?.closest("p")).not.toBeNull());
    expect(peerCaret()!.closest("table")).toBeNull();
    rerender({ presenceCursors: [ada(2, 12)] });
    await waitFor(() => expect(peerCaret()).toBeNull());
  });

  it("sits in a table cell as drawn text: hidden from assistive tech, not an editable widget", async () => {
    renderEditor({ text: "| Left | Right |\n| --- | --- |\n| A | B |", presenceCursors: [ada(2, 3)] });
    await waitFor(() => expect(peerCaret()?.closest("td")).toHaveTextContent("A"));
    expect(peerCaret()).toHaveAttribute("aria-hidden", "true");
    expect(peerCaret()).not.toHaveAttribute("contenteditable");
    expect(peerCaret()).not.toHaveClass("ProseMirror-widget");
  });

  it.each([
    ["the header cell for a delimiter row", "| Left | Right |\n| --- | --- |\n| A | B |", 1, 3, "th"],
    ["the merged cell's origin for a merged-away cell", '<!-- lattice-table-layout:v1 {"spans":[[0,0,1,2]]} -->\n\n| Group | Group | Metric |\n| --- | --- | --- |\n| A | B | 1 |', 2, 11, "th"],
  ])("anchors in %s", async (_label, text, row, column, cell) => {
    renderEditor({ text, presenceCursors: [ada(row, column)] });
    await waitFor(() => expect(peerCaret()?.closest(cell)).toBe(document.querySelector(cell)));
  });
});

describe("comments (R-SRC-5–7, R-SRC-9)", () => {
  const comment = (overrides: Partial<EditorComment> = {}): EditorComment => ({
    id: "c1", path: "notes.md", from: 10, to: 19, quote: "brown fox", prefix: "quick ", suffix: " jumps",
    body: "why this one?", authorId: "ada", authorName: "Ada", resolved: false, replies: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  });

  it.each([true, false])("highlights exactly the quote and previews the thread on hover and focus (editable: %s)", async (editable) => {
    const onEditorCommentClick = vi.fn();
    const { unmount } = renderEditor({
      text: "The quick brown fox jumps.",
      editable,
      editorComments: [
        comment({ replies: [{ id: "r1", authorId: "grace", authorName: "Grace", body: "Because it is the example.", createdAt: "2026-01-02T00:00:00.000Z" }] }),
        comment({ id: "c2", from: 4, to: 9, quote: "quick", prefix: "The ", suffix: " brown", resolved: true }),
      ],
      onEditorCommentClick,
    });
    const mark = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-lx-comment='c1']");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(mark.textContent).toBe("brown fox");
    expect(document.querySelector("[data-lx-comment='c2']")).toBeNull();
    fireEvent.mouseOver(mark);
    const card = await screen.findByRole("tooltip");
    expect(mark).toHaveAttribute("aria-describedby", card.id);
    for (const text of ["Ada", "why this one?", "Grace", "Because it is the example."]) expect(card).toHaveTextContent(text);
    fireEvent.mouseOut(mark, { relatedTarget: card });
    expect(screen.getByRole("tooltip")).toBe(card);
    fireEvent.keyDown(mark, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focusIn(mark);
    await screen.findByRole("tooltip");
    fireEvent.click(mark);
    expect(onEditorCommentClick).toHaveBeenCalledWith("c1");
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseOver(mark);
    await screen.findByRole("tooltip");
    fireEvent.scroll(document);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focusIn(mark);
    await screen.findByRole("tooltip");
    unmount();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    [false, "submit"], [true, "submit"], [false, "cancel"], [true, "escape"],
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
    else {
      fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), { target: { value: "Please clarify this." } });
      fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
      expect(onCreateComment).toHaveBeenCalledWith(pendingEdit ? 4 : 0, pendingEdit ? 9 : 5, "Please clarify this.");
    }
    if (action !== "submit") expect(onCreateComment).not.toHaveBeenCalled();
    expect(surface().querySelector(".lx-md-comment-draft")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Add comment" })).toBeNull();
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

  it("offers only Comment in a read-only document", async () => {
    const { editor } = renderEditor({ editable: false, onCreateComment: vi.fn() });
    expect(surface()).toHaveAttribute("contenteditable", "false");
    select(editor, 1, 6);
    expect(await screen.findByRole("button", { name: "Comment" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Block type" })).toBeNull();
  });
});

describe("tracked changes (R-SRC-8)", () => {
  const suggestion = (id: string, overrides: object = {}) => ({ id, position: 1, text: "ell", deletion: false, userId: "ada", timestamp: null, hue: 210, ...overrides });
  const actions = () => ({ authorName: vi.fn(() => "Ada"), canAct: vi.fn(() => true), onAccept: vi.fn(), onReject: vi.fn() });
  const change = (id: string) => document.querySelector<HTMLElement>(`[data-lx-change='${id}']`);

  it("highlights an insertion and offers Accept and Reject", async () => {
    const insertion = suggestion("s1");
    const trackActions = actions();
    renderEditor({ overleafChanges: [insertion], overleafTrackChangeActions: trackActions });
    await waitFor(() => expect(change("s1")).toHaveTextContent("ell"));
    expect(change("s1")).toHaveClass("is-insert");
    fireEvent.mouseOver(change("s1")!);
    const popover = await screen.findByRole("dialog", { name: "Suggested change" });
    expect(popover).toHaveTextContent("Ada");
    fireEvent.mouseOver(change("s1")!.parentElement!);
    expect(screen.getByRole("dialog", { name: "Suggested change" })).toBe(popover);
    fireEvent.click(within(popover).getByRole("button", { name: "Accept" }));
    expect(trackActions.onAccept).toHaveBeenCalledWith(insertion);
    fireEvent.mouseOver(change("s1")!);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(trackActions.onReject).toHaveBeenCalledWith(insertion);
  });

  it("survives the pointer crossing to it, and holds focus when opened from the keyboard", async () => {
    renderEditor({ overleafChanges: [suggestion("s2")], overleafTrackChangeActions: actions() });
    const mark = await waitFor(() => {
      expect(change("s2")).not.toBeNull();
      return change("s2")!;
    });
    setRect(mark, { left: 100, right: 150, top: 100, bottom: 120 });
    fireEvent.mouseOver(mark);
    const popover = await screen.findByRole("dialog", { name: "Suggested change" });
    setRect(popover, { left: 100, right: 280, top: 60, bottom: 90 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 95 });
    expect(popover).toBeInTheDocument();
    fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
    await waitFor(() => expect(popover).not.toBeInTheDocument());
    act(() => change("s2")!.focus());
    fireEvent.keyDown(change("s2")!, { key: "Enter" });
    const accept = await screen.findByRole("button", { name: "Accept" });
    await waitFor(() => expect(accept).toHaveFocus());
    fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
    expect(accept).toBeInTheDocument();
    fireEvent.keyDown(accept, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Suggested change" })).toBeNull());
    expect(change("s2")).toHaveFocus();
  });

  it("shows removed text at its place", async () => {
    renderEditor({ overleafChanges: [suggestion("d1", { text: "removed", deletion: true })], overleafTrackChangeActions: actions() });
    await waitFor(() => expect(change("d1")).toHaveTextContent("removed"));
    expect(change("d1")).toHaveClass("is-delete");
    expect(change("d1")!.parentElement).toHaveTextContent("Hremovedello");
  });

  it("acts on the latest suggestion after canonical text moved it", async () => {
    const first = suggestion("s3", { text: "irs" });
    const moved = { ...first, position: 2, text: "con" };
    const trackActions = actions();
    const { rerender } = renderEditor({ text: "First", overleafChanges: [first], overleafTrackChangeActions: trackActions });
    await waitFor(() => expect(change("s3")).toHaveTextContent("irs"));
    rerender({ text: "Second", overleafChanges: [moved] });
    await waitFor(() => expect(change("s3")).toHaveTextContent("con"));
    fireEvent.mouseOver(change("s3")!);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(trackActions.onReject).toHaveBeenCalledWith(moved);
  });
});

describe("source labels, View in source and selection context (R-SRC-11, R-SRC-12)", () => {
  it.each([false, true])("labels blocks and reports the selection start (reading: %s)", async (optimizeForReading) => {
    const text = "# Heading\n\nFirst paragraph.\n\nTarget paragraph.";
    const onViewInSource = vi.fn();
    const { editor } = renderEditor({ text, optimizeForReading, onViewInSource, synchronizeSourceScroll: true });
    await waitFor(() => {
      const target = surface().children[2];
      expect(target).toHaveAttribute("data-source-line", "5");
      expect(target).toHaveAttribute("data-source-offset", String(text.indexOf("Target")));
      expect(target).toHaveAttribute("data-source-end-offset", String(text.length));
    });
    const target = nodePos(editor, "Target paragraph.");
    select(editor, target + 7, target + 16);
    fireEvent.click(await screen.findByRole("button", { name: "View in source Markdown" }));
    expect(onViewInSource).toHaveBeenCalledWith(text.indexOf("paragraph.", text.indexOf("Target")));
  });

  it("leaves blocks unlabelled unless the host scrolls by them", () => {
    renderEditor("# Heading\n\nBody.");
    expect(surface().querySelector("[data-source-line]")).toBeNull();
  });

  it("reports a selected block, or selected text, as its Markdown", async () => {
    const onSelectionMarkdown = vi.fn();
    const { editor } = renderEditor({ text: "## Selected context\n\nSome **bold** words", onSelectionMarkdown });
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    });
    expect(onSelectionMarkdown).toHaveBeenLastCalledWith("## Selected context");
    const bold = nodePos(editor, "bold");
    select(editor, bold - 5, bold + 4);
    expect(onSelectionMarkdown).toHaveBeenLastCalledWith("Some **bold");
    select(editor, bold);
    expect(onSelectionMarkdown).toHaveBeenLastCalledWith("");
  });
});
