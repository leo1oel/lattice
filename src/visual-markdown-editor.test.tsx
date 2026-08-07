import { EditorView as CMEditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { useMemo, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addBlockBelow,
  moveBlockUp,
  moveTopLevelBlock,
  PRESERVE_VISUAL_VIEWPORT_META,
  restoreVisualViewportWithReveal,
  type PreserveVisualViewportMeta,
} from "./visual-editor-block-controls";
import { getComponentItems, getInlineComponentItems } from "@ok-app/editor/slash-command/component-items";
import { getEmbedStarterItems } from "@ok-app/editor/slash-command/embed-starter-items";
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("./app-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-notify")>()),
  notifyError: notifications.error,
}));
import { VisualMarkdownEditor } from "./visual-markdown-editor";
import { getMarkdownManager, parseVisualMarkdown } from "./visual-markdown-schema";
import { canonicalizeSupportedMarkdown, preserveMarkdownEnvelope } from "./markdown-collab";
import { tableEnterDown } from "@ok-app/editor/extensions/table-row-enter";
import { LinkPathSuggestionInput } from "@ok-app/editor/link-path-suggestions";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import tutorialMarkdown from "../src-tauri/templates/tutorial/notes.md?raw";
import {
  LARGE_MARKDOWN_PREVIEW_THRESHOLD,
  markdownPreviewSyncPolicy,
} from "./markdown-preview-sync-policy";

afterEach(cleanup);

function rect({ top, bottom }: { top: number; bottom: number }): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

function renderEditor(
  text = "Hello",
  onChange = vi.fn<(next: string, expected: string) => boolean>(() => true),
) {
  const result = render(
    <VisualMarkdownEditor
      text={text}
      activePath="notes.md"
      onChangeMarkdown={onChange}
      onUndo={() => false}
      onRedo={() => false}
    />,
  );
  return { ...result, onChange };
}

function editorMarkdown(editor: Editor): string {
  return getMarkdownManager().serialize(editor.getJSON());
}

async function replaceEditorText(text: string) {
  const editor = screen.getByRole("textbox", { name: "Markdown document editor" });
  editor.innerHTML = `<p>${text}</p>`;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VisualMarkdownEditor", () => {
  it("uses one adaptive synchronization policy for every Markdown preview", () => {
    expect(markdownPreviewSyncPolicy(1_000)).toEqual({
      publicationIdleMs: 200,
      publicationMaxMs: 1_500,
      peerScrollSettleMs: 0,
    });
    expect(markdownPreviewSyncPolicy(LARGE_MARKDOWN_PREVIEW_THRESHOLD)).toEqual({
      publicationIdleMs: 1_000,
      publicationMaxMs: 5_000,
      peerScrollSettleMs: 140,
    });
  });

  it("draws a fixed-height caret that does not grow with heading line boxes", async () => {
    renderEditor("# Title\n\nBody paragraph.");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let headingPos = 1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "heading") headingPos = position + 1;
    });

    const host = surface.closest<HTMLElement>(".visual-markdown-editor") ?? surface;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 600,
      width: 400,
      height: 600,
      toJSON: () => ({}),
    });
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      top: 40,
      bottom: 88,
      left: 64,
      right: 64,
    });

    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection(headingPos);
    });

    const caret = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".visual-fixed-caret");
      expect(element).not.toBeNull();
      expect(element?.hidden).toBe(false);
      return element!;
    });
    expect(caret.style.height).toBe("22px");
    expect(caret.style.top).toBe("53px");
    expect(caret.style.left).toBe("64px");
    expect(surface).toHaveAttribute("data-fixed-caret");
  });

  it("draws Overleaf cursors and publishes the visual caret in Markdown coordinates", async () => {
    const onCaretChange = vi.fn();
    const onSourceCaretChange = vi.fn();
    render(
      <VisualMarkdownEditor
        text="# Hello"
        activePath="presence-heading.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 0, column: 4 }]}
        onCaretChange={onCaretChange}
        onSourceCaretChange={onSourceCaretChange}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(document.querySelector(".visual-overleaf-caret-label")).toHaveTextContent("Ada"));

    act(() => {
      editor.commands.setTextSelection(3);
    });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(0, 4));
    expect(onSourceCaretChange).toHaveBeenLastCalledWith(4);
  });

  it("paints a comment over the prose it is anchored to, and opens it on click", async () => {
    const onEditorCommentClick = vi.fn();
    const source = "The quick brown fox jumps.";
    const comment = {
      id: "c1",
      path: "commented.md",
      from: source.indexOf("brown fox"),
      to: source.indexOf("brown fox") + "brown fox".length,
      quote: "brown fox",
      prefix: "quick ",
      suffix: " jumps",
      body: "why this one?",
      authorId: "ada",
      authorName: "Ada",
      resolved: false,
      replies: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <VisualMarkdownEditor
        text={source}
        activePath="commented.md"
        editorComments={[comment]}
        onEditorCommentClick={onEditorCommentClick}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const mark = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-visual-comment-id='c1']");
      expect(found).not.toBeNull();
      return found!;
    });
    // The highlight covers the quoted prose, not the whole paragraph.
    expect(mark.textContent).toBe("brown fox");
    fireEvent.click(mark);
    expect(onEditorCommentClick).toHaveBeenCalledWith("c1");
  });

  it("leaves a resolved comment unpainted", async () => {
    const source = "The quick brown fox jumps.";
    const base = {
      id: "c1", path: "resolved.md", from: 4, to: 9, quote: "quick", prefix: "The ", suffix: " brown",
      body: "b", authorId: "ada", authorName: "Ada", replies: [],
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    render(
      <VisualMarkdownEditor
        text={source}
        activePath="resolved.md"
        editorComments={[{ ...base, resolved: true }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await screen.findByRole("textbox", { name: "Markdown document editor" });
    expect(document.querySelector("[data-visual-comment-id]")).toBeNull();
  });

  it("draws and updates an Overleaf cursor inside an editable code block", async () => {
    const markdown = "```js\nconst value = 1\n```";
    const codeTextBefore = (caret: HTMLElement) => {
      const code = caret.closest("code")!;
      const range = document.createRange();
      range.selectNodeContents(code);
      range.setEndBefore(caret);
      return range.toString();
    };
    const { rerender } = render(
      <VisualMarkdownEditor
        text={markdown}
        activePath="presence-code.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 1, column: 5 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const firstCaret = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".visual-overleaf-caret");
      expect(element?.closest(".ok-codeblock-pre code")).not.toBeNull();
      return element!;
    });
    expect(codeTextBefore(firstCaret)).toBe("const");

    rerender(
      <VisualMarkdownEditor
        text={markdown}
        activePath="presence-code.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 1, column: 11 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => {
      const moved = document.querySelector<HTMLElement>(".visual-overleaf-caret");
      expect(moved).not.toBe(firstCaret);
      expect(moved?.closest(".ok-codeblock-pre code")).not.toBeNull();
      expect(codeTextBefore(moved!)).toBe("const value");
    });
  });

  it("reveals preview source while an Overleaf cursor is inside its code", async () => {
    const markdown = "```html preview\n<p>Hello</p>\n```";
    const renderEditorWithCursors = (presenceCursors: Array<{ name: string; hue: number; row: number; column: number }>) => (
      <VisualMarkdownEditor
        text={markdown}
        activePath="presence-preview-code.md"
        presenceCursors={presenceCursors}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />
    );
    const { rerender } = render(renderEditorWithCursors([
      { name: "Ada", hue: 210, row: 1, column: 3 },
    ]));

    const block = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ok-codeblock[data-language="html"]');
      expect(element).toHaveAttribute("data-code-visible", "true");
      expect(element?.querySelector(".visual-overleaf-caret")?.closest("code")).not.toBeNull();
      return element!;
    });

    rerender(renderEditorWithCursors([]));
    await waitFor(() => expect(block).toHaveAttribute("data-code-visible", "false"));
  });

  it.each([
    { row: 0, column: 1, label: "opening fence" },
    { row: 2, column: 1, label: "closing fence" },
  ])("does not misplace a source-only cursor from a code block $label", async ({ row, column }) => {
    render(
      <VisualMarkdownEditor
        text={"```js\nconst value = 1\n```"}
        activePath="presence-code-fence.md"
        presenceCursors={[{ name: "Ada", hue: 210, row, column }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(document.querySelector(".ok-codeblock")).not.toBeNull());
    expect(document.querySelector(".visual-overleaf-caret")).toBeNull();
  });

  it("maps marked, nested, and emoji visual carets back to exact source columns", async () => {
    const onCaretChange = vi.fn();
    render(
      <VisualMarkdownEditor
        text={"**bold**\n\n- one\n- two 😀"}
        activePath="presence-marks.md"
        onCaretChange={onCaretChange}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let boldPosition = 0;
    let secondItemPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "bold") boldPosition = position;
      if (node.isText && node.text === "two 😀") secondItemPosition = position;
    });

    act(() => { editor.commands.setTextSelection(boldPosition + 2); });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(0, 4));
    act(() => { editor.commands.setTextSelection(secondItemPosition + "two 😀".length); });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(3, 8));
    act(() => { editor.commands.insertContent("!"); });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(3, 9));
  });

  it("publishes visual carets in the original CRLF coordinate space", async () => {
    const onCaretChange = vi.fn();
    render(
      <VisualMarkdownEditor
        text={"A\r\n\r\nB\r\n"}
        activePath="presence-crlf.md"
        onCaretChange={onCaretChange}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let position = 0;
    editor.state.doc.descendants((node, nodePosition) => {
      if (node.isText && node.text === "B") position = nodePosition + 1;
    });

    act(() => { editor.commands.setTextSelection(position); });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(2, 1));
  });

  it("publishes a caret from an untouched MDX component body", async () => {
    const onCaretChange = vi.fn();
    render(
      <VisualMarkdownEditor
        text={'<Callout title="Exact">\n  Body\n</Callout>'}
        activePath="presence-mdx.md"
        onCaretChange={onCaretChange}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let bodyPosition = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "Body") bodyPosition = position;
    });

    act(() => { editor.commands.setTextSelection(bodyPosition + 2); });
    await waitFor(() => expect(onCaretChange).toHaveBeenLastCalledWith(1, 4));
  });

  it("does not confuse a visible heading hash with Markdown heading punctuation", async () => {
    render(
      <VisualMarkdownEditor
        text="# # Title"
        activePath="presence-heading-hash.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 0, column: 3 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const caret = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".visual-overleaf-caret");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(caret.closest("h1")).not.toBeNull();
    expect(caret.previousSibling).toHaveTextContent("#");
  });

  it("does not draw an unmappable source-only cursor at the document start", async () => {
    render(
      <VisualMarkdownEditor
        text="![Alt](image.png)"
        activePath="presence-atom.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 0, column: 10 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      document.querySelector(".visual-markdown-editor"),
    ).toBeInTheDocument());
    expect(document.querySelector(".visual-overleaf-caret")).toBeNull();
  });

  it("rebuilds a remote cursor after canonical Markdown is replaced", async () => {
    const cursor = [{ name: "Ada", hue: 210, row: 0, column: 4 }];
    const { rerender } = render(
      <VisualMarkdownEditor
        text="First"
        activePath="presence-reconcile.md"
        presenceCursors={cursor}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      document.querySelector(".visual-overleaf-caret")?.previousSibling,
    ).toHaveTextContent("Firs"));

    rerender(
      <VisualMarkdownEditor
        text="Second"
        activePath="presence-reconcile.md"
        presenceCursors={cursor}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      document.querySelector(".visual-overleaf-caret")?.previousSibling,
    ).toHaveTextContent("Seco"));
  });

  it("highlights an Overleaf suggestion and exposes accept and reject actions", async () => {
    const change = {
      id: "suggestion-1",
      position: 1,
      text: "ell",
      deletion: false,
      userId: "ada",
      timestamp: null,
      hue: 210,
    };
    const actions = {
      authorName: vi.fn(() => "Ada"),
      canAct: vi.fn(() => true),
      onAccept: vi.fn(),
      onReject: vi.fn(),
    };
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="presence-suggestion.md"
        overleafChanges={[change]}
        overleafTrackChangeActions={actions}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-1']");
      expect(element).not.toBeNull();
    });
    const mark = document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-1']")!;
    expect(mark).toHaveClass("visual-tracked-change-insert");
    expect(mark).toHaveTextContent("ell");
    fireEvent.mouseOver(mark);
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    fireEvent.mouseOver(mark.parentElement!);
    expect(screen.getByRole("dialog", { name: "Suggested change" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(actions.onAccept).toHaveBeenCalledWith(change);
    fireEvent.mouseOver(document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-1']")!);
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(actions.onReject).toHaveBeenCalledWith(change);
  });

  it("keeps suggestion actions open while the pointer crosses the popover gap", async () => {
    const change = {
      id: "suggestion-hover-gap",
      position: 1,
      text: "ell",
      deletion: false,
      userId: "ada",
      timestamp: null,
      hue: 210,
    };
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="suggestion-hover-gap.md"
        overleafChanges={[change]}
        overleafTrackChangeActions={{
          authorName: () => "Ada",
          canAct: () => true,
          onAccept: vi.fn(),
          onReject: vi.fn(),
        }}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(
      document.querySelector("[data-visual-change-id='suggestion-hover-gap']"),
    ).not.toBeNull());
    const mark = document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-hover-gap']")!;
    vi.spyOn(mark, "getBoundingClientRect").mockReturnValue({
      left: 100, right: 150, top: 100, bottom: 120,
    } as DOMRect);
    fireEvent.mouseOver(mark);
    const popover = await screen.findByRole("dialog", { name: "Suggested change" });
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue({
      left: 100, right: 280, top: 60, bottom: 90,
    } as DOMRect);

    fireEvent.pointerMove(window, { clientX: 110, clientY: 95 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(popover).toBeInTheDocument();

    fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
    await waitFor(() => expect(popover).not.toBeInTheDocument());
  });

  it("keeps keyboard-open suggestion actions stable and restores trigger focus", async () => {
    const change = {
      id: "suggestion-keyboard",
      position: 1,
      text: "ell",
      deletion: false,
      userId: "ada",
      timestamp: null,
      hue: 210,
    };
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="suggestion-keyboard.md"
        overleafChanges={[change]}
        overleafTrackChangeActions={{
          authorName: () => "Ada",
          canAct: () => true,
          onAccept: vi.fn(),
          onReject: vi.fn(),
        }}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(
      document.querySelector("[data-visual-change-id='suggestion-keyboard']"),
    ).not.toBeNull());
    const mark = document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-keyboard']")!;
    mark.focus();
    fireEvent.keyDown(mark, { key: "Enter" });
    const accept = await screen.findByRole("button", { name: "Accept" });
    await waitFor(() => expect(accept).toHaveFocus());

    fireEvent.pointerMove(window, { clientX: 1000, clientY: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(accept).toBeInTheDocument();

    fireEvent.keyDown(accept, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Suggested change" })).toBeNull());
    expect(mark).toHaveFocus();
  });

  it("renders deleted suggestion text at its zero-width Overleaf anchor", async () => {
    const deletion = {
      id: "deletion-1",
      position: 1,
      text: "removed",
      deletion: true,
      userId: "ada",
      timestamp: null,
      hue: 210,
    };
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="presence-deletion.md"
        overleafChanges={[deletion]}
        overleafTrackChangeActions={{
          authorName: () => "Ada",
          canAct: () => true,
          onAccept: vi.fn(),
          onReject: vi.fn(),
        }}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(
      document.querySelector("[data-visual-change-id='deletion-1']"),
    ).toHaveTextContent("removed"));
    const mark = document.querySelector<HTMLElement>("[data-visual-change-id='deletion-1']")!;
    expect(mark).toHaveClass("visual-tracked-change-delete");
    expect(mark.parentElement).toHaveTextContent("Hremovedello");
  });

  it("rebuilds and acts on the latest suggestion after a canonical update", async () => {
    const initial = {
      id: "suggestion-moving",
      position: 1,
      text: "irs",
      deletion: false,
      userId: "ada",
      timestamp: null,
      hue: 210,
    };
    const shifted = { ...initial, position: 2, text: "con" };
    const onReject = vi.fn();
    const actions = {
      authorName: () => "Ada",
      canAct: () => true,
      onAccept: vi.fn(),
      onReject,
    };
    const { rerender } = render(
      <VisualMarkdownEditor
        text="First"
        activePath="suggestion-reconcile.md"
        overleafChanges={[initial]}
        overleafTrackChangeActions={actions}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      document.querySelector("[data-visual-change-id='suggestion-moving']"),
    ).toHaveTextContent("irs"));

    rerender(
      <VisualMarkdownEditor
        text="Second"
        activePath="suggestion-reconcile.md"
        overleafChanges={[shifted]}
        overleafTrackChangeActions={actions}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      document.querySelector("[data-visual-change-id='suggestion-moving']"),
    ).toHaveTextContent("con"));
    fireEvent.mouseOver(document.querySelector<HTMLElement>("[data-visual-change-id='suggestion-moving']")!);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith(shifted);
  });

  it("keeps converter anchors invisible and lossless in visual mode", async () => {
    const markdown = '<a id="S3.F1"></a>\n\n![Figure](paper_assets/figure.png)\n\n*Figure 1: Model overview.*\n\nSee Figure [1](#S3.F1).\n';
    renderEditor(markdown);

    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const target = document.querySelector<HTMLElement>('[data-markdown-anchor][id="S3.F1"]');
    expect(target).not.toBeNull();
    expect(screen.queryByText('<a id="S3.F1"></a>')).not.toBeInTheDocument();
    expect(screen.queryByText(/Visual editing is unavailable/)).not.toBeInTheDocument();
    expect(editorMarkdown(editor)).toBe(markdown);
    const scrollIntoView = vi.spyOn(target!, "scrollIntoView");
    fireEvent.click(screen.getByRole("link", { name: "1" }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("keeps paper reading editable without scroll-heavy table chrome", () => {
    render(
      <VisualMarkdownEditor
        text={"| Column |\n| --- |\n| Value |"}
        activePath=".research/papers/example/paper.md"
        optimizeForReading
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const extensionNames = editor.extensionManager.extensions.map((extension) => extension.name);
    expect(extensionNames).not.toContain("frozenTableHeaders");
    expect(extensionNames).not.toContain("tableInsertControls");
    expect(surface).toHaveAttribute("contenteditable", "true");
  });

  it("coalesces rapid reading-preview edits before serializing the document", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath=".research/papers/example/paper.md"
        optimizeForReading
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;

    act(() => {
      editor.commands.insertContentAt(6, " a");
      editor.commands.insertContentAt(8, " b");
      editor.commands.insertContentAt(10, " c");
    });

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    expect(onChange).toHaveBeenCalledWith("Hello a b c", "Hello");
  });

  it("uses the same deferred publication outside reading mode", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;

    act(() => {
      editor.commands.insertContentAt(6, " a");
      editor.commands.insertContentAt(8, " b");
      editor.commands.insertContentAt(10, " c");
    });

    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 1_000 });
    expect(onChange).toHaveBeenCalledWith("Hello a b c", "Hello");
  });

  it("flushes a pending paper edit before a mode or tab unmount", () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    const view = render(
      <VisualMarkdownEditor
        text="Hello"
        activePath=".research/papers/example/paper.md"
        optimizeForReading
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => editor.commands.insertContentAt(6, " final"));

    view.unmount();

    expect(onChange).toHaveBeenCalledWith("Hello final", "Hello");
  });

  it("reuses the TipTap instance when switching Markdown files", () => {
    const { rerender } = render(
      <VisualMarkdownEditor
        text="Alpha document"
        activePath="a.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    expect(surface).toHaveTextContent("Alpha document");

    rerender(
      <VisualMarkdownEditor
        text="Beta document"
        activePath="b.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const nextSurface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const nextEditor = (nextSurface as HTMLElement & { editor: Editor }).editor;
    expect(nextEditor).toBe(editor);
    expect(nextSurface).toHaveTextContent("Beta document");
    expect(nextSurface).not.toHaveTextContent("Alpha document");
  });

  it("publishes a pending edit for the previous file when the path switches", () => {
    const publishes: { path: string; next: string; expected: string }[] = [];
    function Harness({ path, text }: { path: string; text: string }) {
      // Recreate the publisher when the path prop changes so changeRef from the
      // previous commit still publishes against the old file during layout flush.
      const publisher = useMemo(
        () => (next: string, expected: string) => {
          publishes.push({ path, next, expected });
          return true;
        },
        [path],
      );
      return (
        <VisualMarkdownEditor
          text={text}
          activePath={path}
          onChangeMarkdown={publisher}
          onUndo={() => false}
          onRedo={() => false}
        />
      );
    }

    const view = render(<Harness path="a.md" text="Alpha" />);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => editor.commands.insertContentAt(6, " edit"));

    act(() => {
      view.rerender(<Harness path="b.md" text="Beta" />);
    });

    expect(publishes).toEqual([{ path: "a.md", next: "Alpha edit", expected: "Alpha" }]);
    expect(screen.getByRole("textbox", { name: "Markdown document editor" }))
      .toHaveTextContent("Beta");
  });

  it("does not let Undo restore the previous file after a path switch", () => {
    const onUndo = vi.fn(() => true);
    const { rerender } = render(
      <VisualMarkdownEditor
        text="Alpha"
        activePath="a.md"
        onChangeMarkdown={() => true}
        onUndo={onUndo}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => editor.commands.insertContentAt(6, " edited"));
    expect(surface).toHaveTextContent("Alpha edited");

    rerender(
      <VisualMarkdownEditor
        text="Beta"
        activePath="b.md"
        onChangeMarkdown={() => true}
        onUndo={onUndo}
        onRedo={() => false}
      />,
    );
    const nextSurface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const nextEditor = (nextSurface as HTMLElement & { editor: Editor }).editor;
    expect(nextEditor).toBe(editor);
    expect(nextSurface).toHaveTextContent("Beta");

    // History is delegated to the host. After a path swap, Mod-z must not
    // walk TipTap's previous-file stack back to Alpha.
    act(() => {
      nextEditor.commands.keyboardShortcut("Mod-z");
    });
    expect(onUndo).toHaveBeenCalledOnce();
    expect(nextSurface).toHaveTextContent("Beta");
    expect(nextSurface).not.toHaveTextContent("Alpha");
  });

  it("swaps files that share identical body text", () => {
    const { rerender } = render(
      <VisualMarkdownEditor
        text="Same body"
        activePath="a.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => editor.commands.insertContentAt(10, "!"));
    expect(surface).toHaveTextContent("Same body!");

    rerender(
      <VisualMarkdownEditor
        text="Same body"
        activePath="b.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const nextSurface = screen.getByRole("textbox", { name: "Markdown document editor" });
    expect((nextSurface as HTMLElement & { editor: Editor }).editor).toBe(editor);
    expect(nextSurface).toHaveTextContent("Same body");
    expect(nextSurface).not.toHaveTextContent("Same body!");
  });

  it("adds a slash block without unnecessary split preview movement", async () => {
    const onRequestViewportLock = vi.fn();
    render(
      <VisualMarkdownEditor
        text="First\n\nSecond"
        activePath="notes.md"
        onChangeMarkdown={() => true}
        onRequestViewportLock={onRequestViewportLock}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const viewport = surface.closest<HTMLElement>(".visual-markdown-editor")!;
    viewport.classList.add("editor-doc-scroll");
    viewport.scrollTop = 480;
    const localScrollWrites: number[] = [];
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => 480,
      set: (value: number) => localScrollWrites.push(value),
    });
    const transactions: boolean[] = [];
    let preserveViewport: PreserveVisualViewportMeta | undefined;
    const dispatch = editor.view.dispatch.bind(editor.view);
    vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
      transactions.push(transaction.scrolledIntoView);
      const viewportMeta = transaction.getMeta(PRESERVE_VISUAL_VIEWPORT_META) as
        PreserveVisualViewportMeta | undefined;
      if (viewportMeta) preserveViewport = viewportMeta;
      dispatch(transaction);
    });

    addBlockBelow(editor, 0, editor.state.doc.firstChild!);

    expect(transactions[0]).toBe(false);
    expect(localScrollWrites).toEqual([]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.textContent).toBe("/");
    expect(onRequestViewportLock).toHaveBeenCalledTimes(1);
    const firstAnchor = onRequestViewportLock.mock.calls[0]?.[0] as HTMLElement;
    const firstAnchorTop = onRequestViewportLock.mock.calls[0]?.[1] as number;
    expect(firstAnchor).toHaveTextContent("First");
    const shiftedAnchor = document.createElement("p");
    shiftedAnchor.textContent = "First";
    document.body.append(shiftedAnchor);
    vi.spyOn(shiftedAnchor, "getBoundingClientRect").mockReturnValue(
      rect({ top: firstAnchorTop - 36, bottom: firstAnchorTop + 12 }),
    );
    const nodeDom = editor.view.nodeDOM.bind(editor.view);
    vi.spyOn(editor.view, "nodeDOM").mockImplementation((position) => (
      position === preserveViewport?.anchorPosition ? shiftedAnchor : nodeDom(position)
    ));
    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    await waitFor(() => expect(onRequestViewportLock).toHaveBeenCalledTimes(2));
    const deferredAnchor = onRequestViewportLock.mock.calls[1]?.[0] as HTMLElement | null;
    const deferredAnchorTop = onRequestViewportLock.mock.calls[1]?.[1];
    // The first lock may intentionally scroll down to reveal the inserted row.
    // Deferred publication must preserve that new position, not restore the
    // clicked block's pre-insertion screen coordinate.
    expect(deferredAnchor).not.toBeNull();
    expect(deferredAnchor).toHaveTextContent("First");
    expect(deferredAnchorTop).toBe(firstAnchorTop - 36);
    await waitFor(() => expect(viewport.scrollTop).toBe(480));
  });

  it("reveals an added block below the viewport with bottom breathing room", () => {
    const viewport = document.createElement("div");
    const anchor = document.createElement("p");
    const reveal = document.createElement("p");
    viewport.append(anchor, reveal);
    document.body.append(viewport);
    viewport.scrollTop = 480;
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(rect({ top: 100, bottom: 600 }));
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(rect({ top: 400, bottom: 450 }));
    const revealRect = vi.spyOn(reveal, "getBoundingClientRect");

    revealRect.mockReturnValue(rect({ top: 520, bottom: 580 }));
    restoreVisualViewportWithReveal(viewport, 480, anchor, 400, reveal);
    expect(viewport.scrollTop).toBe(480);

    revealRect.mockReturnValue(rect({ top: 590, bottom: 645 }));
    restoreVisualViewportWithReveal(viewport, 480, anchor, 400, reveal);
    expect(viewport.scrollTop).toBe(565);
  });

  it("keeps tutorial fenced-code bodies when the block plus action adds a slash paragraph", async () => {
    const { onChange } = renderEditor(tutorialMarkdown);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(document.querySelectorAll(".ok-codeblock")).toHaveLength(3));
    await waitFor(() => {
      const callout = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      const accordion = document.querySelector<HTMLElement>('[data-component-name="Accordion"]');
      expect(callout?.querySelector(".callout-body")).toHaveTextContent(
        "Attention weights show routing patterns",
      );
      expect(accordion?.querySelector(".accordion-body")).toHaveTextContent(
        "Scaling keeps the softmax distribution",
      );
      expect(accordion?.querySelector("details.accordion")).toHaveAttribute("open");
    });
    expect(screen.getByRole("img", {
      name: "Scaled dot-product attention from Figure 2 of the Transformer paper",
    }).closest(".ok-image-resizable")).toHaveStyle({ width: "223px" });

    act(() => addBlockBelow(editor, 0, editor.state.doc.firstChild!));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const codeNodes: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "codeBlock") codeNodes.push(node.textContent);
    });
    expect(codeNodes[0]).toContain("scores = queries");
    expect(codeNodes[1]).toContain("flowchart LR");
    expect(codeNodes[2]).toContain("Select a query token");
    expect(Array.from(document.querySelectorAll(".ok-codeblock-pre")).map((node) => node.textContent))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("scores = queries"),
        expect.stringContaining("flowchart LR"),
        expect.stringContaining("Select a query token"),
      ]));
    const output = String(onChange.mock.lastCall?.[0]);
    expect(output).toContain([
      "```python title=\"Scaled dot-product attention in NumPy\"",
      "import numpy as np",
      "",
      "def softmax(values: np.ndarray, axis: int = -1) -> np.ndarray:",
      "    shifted = values - values.max(axis=axis, keepdims=True)",
      "    exponentials = np.exp(shifted)",
      "    return exponentials / exponentials.sum(axis=axis, keepdims=True)",
    ].join("\n"));
    expect(output).toContain([
      "    key_dimension = keys.shape[-1]",
      "    scores = queries @ keys.swapaxes(-1, -2) / np.sqrt(key_dimension)",
      "    if mask is not None:",
      "        scores = np.where(mask, scores, -np.inf)",
      "    weights = softmax(scores, axis=-1)",
    ].join("\n"));
    expect(output).toContain([
      "```mermaid title=\"From queries and keys to contextual representations\"",
      "flowchart LR",
      "  Q[Queries] --> S[Scaled scores]",
      "  K[Keys] --> S",
      "  S --> W[Softmax weights]",
      "  W --> C[Context]",
      "  V[Values] --> C",
      "```",
    ].join("\n"));
    expect(output).toContain("```html preview h=360px title=\"Embedded attention demo\"");
    expect(output).toContain("render(1);");
    expect(output).toContain("<Callout type=\"important\" title=\"Attention maps need validation\"");
    expect(output).toContain("Compare them with ablations or attribution methods");
    expect(output).toContain("<Accordion title=\"Why scale attention scores?\"");
    expect(output).toContain("Scaling keeps the softmax distribution and its gradients well behaved.");
    expect(output).toContain('width={223}');
  });

  it("keeps accordion block content visible when remounting from Preview to Split", async () => {
    const accordionMarkdown = [
      '<Accordion title="Details" defaultOpen>',
      'A paragraph with **formatted text**.',
      '',
      '- First item',
      '- Second item',
      '',
      '```ts',
      'const scale = Math.sqrt(64);',
      '```',
      '</Accordion>',
    ].join('\n');
    const props = {
      text: accordionMarkdown,
      activePath: "notes.md",
      onChangeMarkdown: () => true,
      onUndo: () => false,
      onRedo: () => false,
    };
    const view = render(
      <VisualMarkdownEditor key="preview" {...props} synchronizeSourceScroll={false} />,
    );

    const expandedAccordion = () => {
      const accordion = document.querySelector<HTMLElement>('[data-component-name="Accordion"]');
      expect(accordion?.querySelector("details.accordion")).toHaveAttribute("open");
      expect(accordion?.querySelector(".accordion-body")).toHaveTextContent(
        "A paragraph with formatted text",
      );
      expect(accordion?.querySelectorAll(".accordion-body li")).toHaveLength(2);
      expect(accordion?.querySelector(".accordion-body code")).toHaveTextContent(
        "const scale = Math.sqrt(64);",
      );
    };
    await waitFor(expandedAccordion);

    view.rerender(
      <VisualMarkdownEditor key="split" {...props} synchronizeSourceScroll />,
    );
    await waitFor(expandedAccordion);
  });

  it("keeps intentional code clearing authoritative", async () => {
    const { onChange } = renderEditor("```js\nconst value = 1\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const code = editor.state.doc.firstChild!;
    act(() => editor.view.dispatch(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, 1, code.nodeSize - 1),
    ).deleteSelection()));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editorMarkdown(editor)).toMatch(/^```js\n\n```/);
  });

  it("keeps authored and canonical empty fences empty", async () => {
    renderEditor("```js\n\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => addBlockBelow(editor, 0, editor.state.doc.firstChild!));
    expect(editor.state.doc.firstChild?.textContent).toBe("");
    expect(editorMarkdown(editor)).toContain("```js\n\n```");
  });

  it("inserts a newline when Enter is pressed inside a code block", async () => {
    const { onChange } = renderEditor("```js\nconst value = 1\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const code = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ok-codeblock-pre code");
      expect(element).toHaveStyle({ whiteSpace: "break-spaces" });
      expect(element).toHaveClass("break-words");
      return element!;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6)));

    fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(editor.state.doc.firstChild?.textContent).toBe("const\n value = 1");
    expect(code.textContent).toBe("const\n value = 1");
    expect(editor.state.selection.from).toBe(7);
    const { from, to } = editor.state.selection;
    const defaultTextInput = () => editor.state.tr.insertText("next", from, to);
    const handled = editor.view.someProp("handleTextInput", (handleTextInput) =>
      handleTextInput(editor.view, from, to, "next", defaultTextInput),
    );
    if (!handled) editor.view.dispatch(defaultTextInput());
    expect(editor.state.doc.firstChild?.textContent).toBe("const\nnext value = 1");
    expect(editor.state.selection.from).toBe(11);
    expect(editorMarkdown(editor)).toContain("const\nnext value = 1");
  });

  it("keeps advancing the code-block cursor beyond Tiptap's triple-Enter exit", () => {
    renderEditor("```js\nconst value = 1\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    expect(editor.extensionManager.extensions
      .filter((extension) => extension.name === "codeBlock")
      .map((extension) => extension.options.exitOnTripleEnter))
      .toEqual([false]);
    const codeNode = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, codeNode.nodeSize - 1),
    ));

    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
    }

    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe("const value = 1\n\n\n\n");
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.selection.from).toBe(codeNode.nodeSize + 3);
  });

  it("renders a trailing newline and accepts text on the new code line", async () => {
    const { onChange } = renderEditor("```js\nsfjaksdf\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const code = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ok-codeblock-pre code");
      expect(element).not.toBeNull();
      return element!;
    });
    const codeNode = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, codeNode.nodeSize - 1),
    ));

    fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });

    expect(code).toHaveStyle({ whiteSpace: "break-spaces" });
    expect(code.textContent).toBe("sfjaksdf\n");
    expect(editor.state.doc.firstChild?.textContent).toBe("sfjaksdf\n");
    const { from, to } = editor.state.selection;
    expect(from).toBe(codeNode.nodeSize);
    editor.view.dispatch(editor.state.tr.insertText("next", from, to));
    expect(code.textContent).toBe("sfjaksdf\nnext");
    expect(editor.state.doc.firstChild?.textContent).toBe("sfjaksdf\nnext");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("sfjaksdf\nnext"));
  });

  it("keeps highlighted line endings outside inline spans so WebKit can advance the caret", async () => {
    renderEditor("```js\n// first line\n// second line\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const code = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ok-codeblock-pre code");
      expect(element).not.toBeNull();
      expect(element!.querySelector(".hljs-comment")).not.toBeNull();
      return element!;
    });

    expect(Array.from(code.querySelectorAll("span")).every((span) => !span.textContent?.includes("\n")))
      .toBe(true);
    const codeNode = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, codeNode.nodeSize - 1),
    ));
    fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });
    const { from, to } = editor.state.selection;
    editor.view.dispatch(editor.state.tr.insertText("// third line", from, to));
    fireEvent.keyDown(surface, { key: "Enter", code: "Enter" });

    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent)
      .toBe("// first line\n// second line\n// third line\n");
    expect(Array.from(code.querySelectorAll("span")).every((span) => !span.textContent?.includes("\n")))
      .toBe(true);
  });

  it("does not move deleted code into a neighboring empty fence", () => {
    renderEditor("```js\nconst removed = true\n```\n\n```css\n\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const firstCode = editor.state.doc.firstChild!;
    act(() => editor.view.dispatch(editor.state.tr.delete(0, firstCode.nodeSize)));
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.attrs.language).toBe("css");
    expect(editor.state.doc.firstChild?.textContent).toBe("");
  });

  it("reports Markdown when the rendered paragraph is directly edited", async () => {
    const { onChange } = renderEditor();
    expect(screen.queryByRole("button", { name: "Edit Markdown source" })).not.toBeInTheDocument();
    await replaceEditorText("Changed");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Changed", "Hello"));
  });

  it("serializes bold formatting from the toolbar", async () => {
    const { onChange } = renderEditor();
    const editor = screen.getByRole("textbox", { name: "Markdown document editor" });
    const view = (editor as HTMLElement & { editor: Editor }).editor.view;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    fireEvent.mouseDown(await screen.findByRole("button", { name: "bold" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("**Hello**", "Hello"));
  });

  it("serializes italic formatting from the toolbar", async () => {
    const { onChange } = renderEditor();
    const editor = screen.getByRole("textbox", { name: "Markdown document editor" });
    const view = (editor as HTMLElement & { editor: Editor }).editor.view;
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    fireEvent.mouseDown(await screen.findByRole("button", { name: "italic" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("*Hello*", "Hello"));
    expect(editor.querySelector("em")).not.toBeNull();
  });

  it("applies the fixed Markdown highlight color", async () => {
    const { onChange } = renderEditor();
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.focus();
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 6)));

    const highlightButton = await screen.findByRole("button", { name: "highlight" });
    fireEvent.mouseDown(highlightButton);

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("==Hello==", "Hello"));
    expect(surface.querySelector("mark")).toHaveAttribute("data-color", "#FFD875");
  });

  it.each(["**nknk**", "**. nknk**", "中文 **粗体** 内容"])(
    "keeps authored bold text visual across a canonical rerender: %s",
    async (markdown) => {
      const { rerender } = renderEditor(markdown);
      const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
      expect(surface.querySelector("strong")).not.toBeNull();
      expect(surface).not.toHaveTextContent("**");
      rerender(
        <VisualMarkdownEditor
          text={`${markdown}\n`}
          activePath="notes.md"
          onChangeMarkdown={() => true}
          onUndo={() => false}
          onRedo={() => false}
        />,
      );
      await waitFor(() => expect(surface.querySelector("strong")).not.toBeNull());
      expect(surface).not.toHaveTextContent("**");
    },
  );

  it("does not report an external text update", async () => {
    const { onChange, rerender } = renderEditor();
    rerender(
      <VisualMarkdownEditor
        text="External"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveTextContent("External"));
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rebases a rejected local draft over a disjoint remote edit without dropping either", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => false);
    const { rerender } = renderEditor("Alpha middle Omega", onChange);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const view = (surface as HTMLElement & { editor: Editor }).editor.view;
    view.dispatch(view.state.tr.insertText(" tail", view.state.doc.content.size - 1));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Alpha middle Omega tail", "Alpha middle Omega"));
    onChange.mockImplementation(() => true);
    rerender(
      <VisualMarkdownEditor
        text="Prefix Alpha middle Omega"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Prefix Alpha middle Omega tail", "Prefix Alpha middle Omega"));
    await waitFor(() => expect(surface).toHaveTextContent("Prefix Alpha middle Omega tail"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a BOM and final-newline envelope pristine and writes one exact CAS update on edit", async () => {
    const { onChange } = renderEditor("\uFEFFHello\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const view = (surface as HTMLElement & { editor: Editor }).editor.view;
    view.dispatch(view.state.tr.insertText(" world", 6));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange).toHaveBeenCalledWith("\uFEFFHello world\n", "\uFEFFHello\n");
  });

  it("keeps remote canonical text authoritative and exposes the complete rejected draft", async () => {
    const onChange = vi.fn(() => false);
    const { rerender } = renderEditor("Canonical", onChange);
    await replaceEditorText("Conflicting");
    rerender(
      <VisualMarkdownEditor
        text="Shared canonical"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("Shared canonical"));
    // The rejected draft rides the notification's Copy button, whole.
    expect(notifications.error.mock.calls.at(-1)![2].copyText).toBe("Conflicting");
  });

  it("shows an accessible contextual toolbar for a text selection", async () => {
    renderEditor();
    // Query the toolbar's content, not the portal container: a previous
    // test's hidden floating-ui container can linger in document.body for a
    // tick after unmount, which made a container-existence check flaky.
    expect(screen.queryByRole("button", { name: "bold" })).not.toBeInTheDocument();
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.focus();
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 6)));
    const bold = await screen.findByRole("button", { name: "bold" });
    const toolbar = bold.closest<HTMLElement>('[data-testid="bubble-menu-bar"]')!;
    expect(bold).toBeEnabled();
    expect(
      toolbar.querySelector('button[aria-label="Convert selection to inline math"]'),
    ).toBeEnabled();
    expect(toolbar).toHaveAttribute("data-testid", "bubble-menu-bar");
    // The toolbar node is portalled outside .tiptap-editor, so it must carry
    // the vendored theme scope itself. Otherwise WebKit paints unstyled
    // buttons with its dark native button face.
    expect(toolbar).toHaveAttribute("data-ok-vendor", "");
    // TipTap v3 portals the toolbar node itself to body. It no longer wraps
    // BubbleMenu in [data-tippy-root], so host styles must target this node.
    expect(toolbar.parentElement).toBe(document.body);
    expect(toolbar.closest("[data-tippy-root]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    fireEvent.blur(surface, { relatedTarget: outside });
    outside.focus();
    await waitFor(() => expect(screen.queryByRole("button", { name: "bold" })).not.toBeInTheDocument());
  });

  it("converts selected text to inline math from the contextual toolbar", async () => {
    const { onChange } = renderEditor("Energy is E=mc^2.");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.focus();
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 11, 17)),
    );

    fireEvent.mouseDown(
      await screen.findByRole("button", { name: "Convert selection to inline math" }),
    );

    let inlineMathFormula: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mathInline") inlineMathFormula = node.attrs.formula as string;
    });
    expect(inlineMathFormula).toBe("E=mc^2");
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("Energy is $E=mc^2$.", "Energy is E=mc^2."),
    );
  });

  it("creates a Markdown comment from the visual selection", async () => {
    const onCreateComment = vi.fn();
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="notes.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
        onCreateComment={onCreateComment}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.focus();
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 6)));

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const composer = await screen.findByRole("dialog", { name: "Add comment" });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Comment" }), {
      target: { value: "Please clarify this." },
    });
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));

    expect(onCreateComment).toHaveBeenCalledWith(0, 5, "Please clarify this.");
  });

  it("keeps comments available while the visual document is read-only", async () => {
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="notes.md"
        editable={false}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
        onCreateComment={vi.fn()}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    expect(surface).toHaveAttribute("contenteditable", "false");
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 6)));

    expect(await screen.findByRole("button", { name: "Comment" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "bold" })).not.toBeInTheDocument();
  });

  it("offers View in source and keeps the footnote icon legible", async () => {
    const onViewInSource = vi.fn<(sourceOffset: number) => void>();
    render(
      <VisualMarkdownEditor
        text="Hello"
        activePath="notes.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
        onViewInSource={onViewInSource}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.focus();
    editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.create(editor.view.state.doc, 1, 6)));

    const viewSource = await screen.findByRole("button", { name: "View in source Markdown" });
    const footnote = await screen.findByTestId("footnote-bubble-button");
    expect(viewSource.querySelector("svg")).toHaveClass("size-4");
    expect(footnote.querySelector("svg")).toHaveClass("size-4");
    fireEvent.click(viewSource);
    expect(onViewInSource).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it.each([false, true])(
    "maps View in source with exact block labels when reading optimization is %s",
    async (optimizeForReading) => {
      const markdown = "# Heading\n\nFirst paragraph.\n\nTarget paragraph.";
      const onViewInSource = vi.fn<(sourceOffset: number) => void>();
      render(
        <VisualMarkdownEditor
          text={markdown}
          activePath="notes.md"
          optimizeForReading={optimizeForReading}
          onChangeMarkdown={() => true}
          onUndo={() => false}
          onRedo={() => false}
          onViewInSource={onViewInSource}
        />,
      );
      const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
      const editor = (surface as HTMLElement & { editor: Editor }).editor;
      let targetPosition = 0;
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text?.startsWith("Target")) targetPosition = position;
      });
      editor.view.focus();
      editor.view.dispatch(editor.view.state.tr.setSelection(
        TextSelection.create(editor.view.state.doc, targetPosition, targetPosition + 6),
      ));

      await waitFor(() => {
        const targetBlock = surface.querySelectorAll(":scope > p, :scope > h1")[2];
        expect(targetBlock).toHaveAttribute("data-source-line", "5");
        expect(targetBlock).toHaveAttribute(
          "data-source-offset",
          String(markdown.indexOf("Target paragraph.")),
        );
        expect(targetBlock).toHaveAttribute("data-source-end-offset", String(markdown.length));
      });
      fireEvent.click(await screen.findByRole("button", { name: "View in source Markdown" }));
      expect(onViewInSource).toHaveBeenCalledWith(
        markdown.indexOf("Target paragraph."),
        expect.any(Number),
      );
    },
  );

  it("mounts Open Knowledge-style add and drag controls for document blocks", async () => {
    renderEditor("First\n\nSecond");
    await waitFor(() => expect(document.querySelector(".ok-block-controls")).not.toBeNull());
    expect(document.querySelector(".ok-add-block-btn")).toHaveAttribute("aria-label", "Add block below");
    expect(document.querySelector(".ok-drag-grip")).toHaveAttribute("aria-label", "Select block");
    expect(document.querySelector(".ok-block-controls")).toHaveAttribute("draggable", "true");
  });

  it("deletes a selected block as one unit", async () => {
    const { onChange } = renderEditor("First\n\nSecond");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.commands.keyboardShortcut("Delete")).toBe(true);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Second", "First\n\nSecond"));
  });

  it("round-trips code language and title metadata through edits and a canonical rerender", async () => {
    const markdown = "```ts title=\"Example with spaces\"\nconst answer = 42;\n```";
    const { onChange, rerender } = renderEditor(markdown);
    // Upstream chrome: language popover trigger announces the resolved label.
    expect(
      await screen.findByRole("button", { name: "Code block language: TypeScript. Click to change." }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ok-codeblock-title")).toHaveTextContent("Example with spaces");
    expect(document.querySelector(".ok-codeblock-pre")).toHaveTextContent("const answer = 42;");
    // Change language through the upstream cmdk picker.
    fireEvent.click(screen.getByRole("button", { name: "Code block language: TypeScript. Click to change." }));
    fireEvent.click(await screen.findByRole("option", { name: "Python" }));
    // Longer timeout: popover close + attr commit + serialize can exceed the
    // 1s default under full-suite parallel load.
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe(
      "```python title=\"Example with spaces\"\nconst answer = 42;\n```",
    ), { timeout: 5000 });
    // Keep the settings popover mounted while a title is typed character by
    // character, then commit the complete value once editing finishes.
    fireEvent.click(screen.getByRole("button", { name: "Code block settings" }));
    const titleInput = await screen.findByTestId("ok-codeblock-title-input");
    for (const value of ["U", "Up", "Updated", "Updated title"]) {
      fireEvent.change(titleInput, { target: { value } });
      expect(screen.getByTestId("ok-codeblock-title-input")).toHaveValue(value);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    }
    expect(String(onChange.mock.lastCall?.[0])).not.toContain('title="Updated title"');
    fireEvent.keyDown(titleInput, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe(
      "```python title=\"Updated title\"\nconst answer = 42;\n```",
    ), { timeout: 5000 });
    rerender(
      <VisualMarkdownEditor
        text={String(onChange.mock.lastCall?.[0])}
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    await waitFor(() => expect(
      screen.getByRole("button", { name: "Code block language: Python. Click to change." }),
    ).toBeInTheDocument());
    expect(screen.getByTestId("ok-codeblock-title")).toHaveTextContent("Updated title");
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    fireEvent.click(screen.getByRole("button", { name: "Delete code block" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe(""));
  });

  it.each(["toml", "mermaid", "html"])("renders a titled %s block with its title attached to the surface", async (language) => {
    const body = language === "mermaid"
      ? "graph TD; A-->B"
      : language === "html"
        ? "<p>Hello</p>"
        : "[tool]\nname = \"demo\"";
    const previewMeta = language === "toml" ? "" : " w=320px";
    renderEditor(`\`\`\`${language} title="Example"${previewMeta}\n${body}\n\`\`\``);
    const block = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(`.ok-codeblock[data-language="${language}"]`);
      expect(element).not.toBeNull();
      return element!;
    });
    const title = within(block).getByTestId("ok-codeblock-title");
    const surface = language === "toml"
      ? block.querySelector(".ok-codeblock-pre")
      : block.querySelector(".ok-codeblock-preview");
    expect(surface).not.toBeNull();
    if (language === "toml") {
      expect(title.compareDocumentPosition(surface!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    } else {
      expect(title.parentElement).toBe(surface);
      expect(surface).toHaveStyle({ width: "320px" });
    }
  });

  it("opens a searchable slash menu and inserts the selected block", async () => {
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/h2").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(menu).toHaveTextContent("Heading 2");
    expect(menu).not.toHaveTextContent("Heading 1");
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /Heading 2/ }));
    await waitFor(() => expect(editor.isActive("heading", { level: 2 })).toBe(true));
    expect(editor.getText()).not.toContain("/h2");
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
  });

  it("offers the complete set of Markdown-native insertions from the add menu", async () => {
    renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(menu.parentElement?.querySelector(".lattice-scrollbar")).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Heading 3/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Task List/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Code Block/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /^Table/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /^Footnote/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Inline Math/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /^Link/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /^Mermaid/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /^Image/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: /^Video/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("option", { name: /^Audio/ })).not.toBeInTheDocument();
  });

  it("composes the slash menu from the vendored upstream item sources", () => {
    // Exact upstream parity is enforced by `vendor-open-knowledge.mjs
    // --check`; here we only pin that the production sources actually
    // surface the canonical component pack in the menu.
    const componentLabels = getComponentItems().map((item) => item.label);
    for (const label of ["Callout", "Accordion", "Tabs", "Image", "Video", "Audio", "PDF", "File", "Embed"]) {
      expect(componentLabels).toContain(label);
    }
    expect(getInlineComponentItems().length).toBeGreaterThan(0);
    expect(getEmbedStarterItems().length).toBeGreaterThan(0);
  });

  it("shares preview selection between hover and arrow navigation", async () => {
    renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    editor.chain().focus().insertContent("/").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(scrollIntoView).not.toHaveBeenCalled();
    const heading2 = within(menu).getByRole("option", { name: /Heading 2/ });
    fireEvent.mouseEnter(heading2);
    await waitFor(() => expect(
      within(screen.getByRole("listbox", { name: "Slash commands" })).getByRole("option", { name: /Heading 2/ }),
    ).toHaveAttribute("aria-selected", "true"));
    expect(menu.parentElement?.parentElement?.querySelector("aside")).toHaveTextContent("Medium section heading.");
    fireEvent.keyDown(surface, { key: "ArrowDown" });
    await waitFor(() => expect(
      within(screen.getByRole("listbox", { name: "Slash commands" })).getByRole("option", { name: /Heading 3/ }),
    ).toHaveAttribute("aria-selected", "true"));
    expect(menu.parentElement?.parentElement?.querySelector("aside")).toHaveTextContent("Small section heading.");
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it("inserts a canonical MDX callout", async () => {
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/callout").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /^Callout/ }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe(
      "<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>",
    ));
  });

  it("edits canonical MDX component content visually and preserves its source until changed", async () => {
    const markdown = "<Callout title=\"Exact\">\nText with **bold**.\n</Callout>";
    const { onChange } = renderEditor(markdown);
    // Upstream JsxComponentView wrapper tags the block with its descriptor name.
    const component = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(component.querySelector("strong")).toHaveTextContent("bold");
    expect(onChange).not.toHaveBeenCalled();
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let textPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.startsWith("Text with")) textPosition = position;
    });
    editor.commands.insertContentAt(textPosition, "Edited ");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("Edited Text with **bold**."));
    expect(component.querySelector(".callout")).not.toBeNull();
    // Upstream prop editing flow: gear button opens the PropPanel popover.
    fireEvent.click(within(component).getByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: /title/i });
    expect(input).toHaveValue("Exact");
    fireEvent.change(input, { target: { value: "Changed & quoted \"title\"" } });
    // Upstream serializes non-portable string props as JSX expressions.
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain(
      'title={"Changed & quoted \\"title\\""}',
    ));
  });

  it("keeps a Callout intact when Chinese IME text is followed by Enter", async () => {
    const { onChange } = renderEditor(
      "<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>",
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") paragraphPosition = position;
    });
    editor.commands.setTextSelection(paragraphPosition + 1);
    fireEvent.compositionStart(surface);
    editor.commands.insertContent("中文");
    // macOS sends the Return that commits the candidate while the editor is
    // still composing. It must not reach the container-exit shortcut against
    // the transient DOM/ProseMirror composition state.
    fireEvent.keyDown(surface, { key: "Enter", code: "Enter", isComposing: true });
    fireEvent.compositionEnd(surface);
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("中文"));
    expect(document.querySelector('[data-component-name="Callout"] .callout')).not.toBeNull();
    expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
    expect(editor.state.doc.firstChild?.childCount).toBeGreaterThanOrEqual(1);
  });

  it("ignores WebKit's trailing Enter when compositionend arrives first", async () => {
    const { onChange } = renderEditor(
      "<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>",
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") paragraphPosition = position;
    });
    editor.commands.setTextSelection(paragraphPosition + 1);
    fireEvent.compositionStart(surface);
    editor.commands.insertContent("中文");
    fireEvent.compositionEnd(surface);
    fireEvent.keyDown(surface, { key: "Enter", code: "Enter", keyCode: 13, isComposing: false });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("中文"));
    expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(document.querySelector('[data-component-name="Callout"] .callout')).not.toBeNull();
  });

  it("does not dismiss Callout properties when Enter commits Chinese IME text", async () => {
    renderEditor("<Callout title=\"Initial\">\nBody\n</Callout>");
    const component = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(within(component).getByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: /title/i });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文标题" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue("中文标题");
    expect(component.querySelector(".callout")).not.toBeNull();
    fireEvent.compositionEnd(input);
  });

  it("keeps Callout properties open for WebKit's compositionend-then-Enter order", async () => {
    renderEditor("<Callout title=\"Initial\">\nBody\n</Callout>");
    const component = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(within(component).getByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: /title/i });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "中文标题" } });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13, isComposing: false });
    expect(screen.getByRole("textbox", { name: /title/i })).toHaveValue("中文标题");
    expect(component.querySelector(".callout")).not.toBeNull();
  });

  it("returns to the Callout body instead of highlighting the whole block after properties close", async () => {
    renderEditor("<Callout title=\"Initial\">\nBody\n</Callout>");
    const component = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(within(component).getByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: /title/i });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /title/i })).not.toBeInTheDocument());
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(editor.state.selection).not.toBeInstanceOf(NodeSelection));
    expect(component.querySelector(".callout")).not.toBeNull();
  });

  it("unmounts an open slash menu without a React removeChild error", async () => {
    const { unmount } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/").run();
    await screen.findByRole("listbox", { name: "Slash commands" });
    expect(() => unmount()).not.toThrow();
  });

  it("repairs an empty Callout produced by an editing transaction", () => {
    renderEditor("<Callout type=\"note\">\nBody\n</Callout>");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const callout = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.delete(1, callout.nodeSize - 1));
    expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
  });

  it("keeps an empty trailing paragraph inside a Callout on Enter", async () => {
    renderEditor("<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let paragraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (paragraphPosition < 0 && node.type.name === "paragraph") paragraphPosition = position;
    });
    editor.commands.setTextSelection(paragraphPosition + 1);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("jsxComponent");
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    await waitFor(() => expect(
      document.querySelector('[data-component-name="Callout"] .callout'),
    ).not.toBeNull());
  });

  it("inserts Tabs as two nested, visually selectable MDX Tab components", async () => {
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/tabs").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /^Tabs/ }));
    const tablist = await screen.findByRole("tablist", { name: "Tabs" });
    // The tab pills derive from child Tab labels and land on a follow-up render.
    await waitFor(() => expect(within(tablist).getAllByRole("tab")).toHaveLength(2));
    const tabs = editor.getJSON().content?.[0] as { content?: Array<{ attrs?: { componentName?: string } }> };
    expect(tabs.content?.map((child) => child.attrs?.componentName)).toEqual(["Tab", "Tab"]);
    await waitFor(() => {
      const output = String(onChange.mock.lastCall?.[0]);
      expect(output).toContain("<Tabs>");
      expect(output).toContain('<Tab label="Tab 1">');
      expect(output).toContain('<Tab label="Tab 2">');
    });
    // Upstream keeps the `+ Add tab` control OUTSIDE the tablist (WAI-ARIA
    // required-owned-elements: a tablist may only own tabs); it's a sibling
    // in the `.tabs-strip` row.
    fireEvent.click(screen.getByRole("button", { name: "Add tab" }));
    await waitFor(() => expect(within(tablist).getAllByRole("tab")).toHaveLength(3));
  });

  it("preserves legacy component fences and migrates them only after a visual edit", async () => {
    const markdown = "```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```";
    const { onChange } = renderEditor(markdown);
    const component = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-component-name="Callout"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(component).getByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: /title/i });
    expect(input).toHaveValue("Legacy");
    fireEvent.change(input, { target: { value: "Migrated" } });
    await waitFor(() => {
      const next = String(onChange.mock.lastCall?.[0]);
      expect(next).toMatch(/^<Callout /);
      expect(next).toContain('title="Migrated"');
      expect(next).toContain("Kept");
      expect(next).not.toContain("rw-component");
    });
  });

  it("does not load unsafe component URLs", async () => {
    renderEditor('<Embed src="javascript:alert(1)" />');
    // Upstream sanitizeComponentProps rewrites unsafe schemes to "#" before
    // render; Embed then refuses to mount an iframe and shows its
    // scheme-hint placeholder instead.
    const component = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-component-name="Embed"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(component.querySelector(".ok-embed--placeholder")).not.toBeNull());
    expect(component.querySelector("iframe")).toBeNull();
    expect(document.body.innerHTML).not.toContain("javascript:alert(1)");
  });

  it("does not let media components load local files or script schemes", async () => {
    // Upstream SAFE_URL_SCHEMES allowlists http/https/mailto/tel/ftp/sms;
    // file: and javascript: are rewritten to an inert "#".
    renderEditor('<Pdf src="file:///etc/passwd" />\n\n<img src="javascript:alert(1)" />');
    const pdf = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-component-name="Pdf"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const image = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-component-name="img"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // sanitizeComponentProps rewrites both URLs to "#": no element may still
    // reference the local file or carry a script scheme.
    expect(pdf.querySelector('[src*="file:"]')).toBeNull();
    expect(image.querySelector('[src*="javascript:"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain("file:///etc/passwd");
    expect(document.body.innerHTML).not.toContain("javascript:alert(1)");
  });

  it("renders Markdown footnote references and definitions as directly editable nodes", async () => {
    const { onChange } = renderEditor("Evidence[^source].\n\n[^source]: Supporting **result**.");
    expect(await screen.findByText("[source]")).toHaveClass("footnote-ref-link");
    // Upstream DOM: auto-numbered aside with the scroll anchor and backref arrow.
    const footnote = document.querySelector<HTMLElement>("aside.footnote-def#fn-source");
    expect(footnote).not.toBeNull();
    expect(footnote!.querySelector("strong")).toHaveTextContent("result");
    expect(footnote!.querySelector('a.footnote-backref[href="#fnref-source"]')).not.toBeNull();
    // The definition body is part of the ProseMirror surface: editing it writes back.
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let pos = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "Supporting ") pos = position;
    });
    editor.chain().focus().setTextSelection(pos).insertContent("Extra ").run();
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("[^source]: Extra Supporting **result**."));
  });

  it("keeps indented paragraphs inside a multiline footnote definition", async () => {
    // GFM footnote continuation paragraphs are indented by four spaces.
    const markdown = "Evidence[^source].\n\n[^source]: First paragraph.\n\n    Second **paragraph**.";
    const { onChange } = renderEditor(markdown);
    await waitFor(() => expect(document.querySelector("aside.footnote-def#fn-source")).not.toBeNull());
    const footnote = document.querySelector<HTMLElement>("aside.footnote-def#fn-source")!;
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Markdown document editor" })).toHaveAttribute("contenteditable", "true"));
    expect(within(footnote).getByText("First paragraph.")).toBeInTheDocument();
    expect(footnote.querySelector("strong")).toHaveTextContent("paragraph");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let pos = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "First paragraph.") pos = position;
    });
    editor.chain().focus().setTextSelection(pos).insertContent("Edited ").run();
    await waitFor(() => {
      const output = String(onChange.mock.lastCall?.[0]);
      expect(output).toContain("[^source]: Edited First paragraph.\n\n    Second **paragraph**.");
    });
  });

  it("inserts Open Knowledge HTML starters as sandboxed preview code blocks", async () => {
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/html").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    expect(within(menu).queryByRole("option", { name: /^Chart/ })).not.toBeInTheDocument();
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /^HTML/ }));
    const preview = await screen.findByTitle("HTML preview");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview.getAttribute("srcdoc")).not.toContain("okPreviewHeight");
    expect(preview.getAttribute("srcdoc")).toContain("scrollbar-color: transparent transparent");
    expect(preview.getAttribute("srcdoc")).toContain("*:hover::-webkit-scrollbar-thumb");
    const previewWrapper = preview.closest<HTMLElement>(".ok-codeblock-preview");
    expect(previewWrapper).toHaveClass("ok-codeblock-preview--html");
    expect(previewWrapper!.querySelector(".ok-resize-handle--l")).not.toBeNull();
    expect(previewWrapper!.querySelector(".ok-resize-handle--r")).not.toBeNull();
    expect(previewWrapper!.querySelector(".ok-resize-handle--b")).toBeNull();
    vi.spyOn(previewWrapper!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 320,
      bottom: 416,
      width: 320,
      height: 416,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const rightHandle = previewWrapper!.querySelector<HTMLElement>(".ok-resize-handle--r");
    const previewViewport = surface.closest<HTMLElement>(".visual-markdown-editor")!;
    previewViewport.classList.add("editor-doc-scroll");
    previewViewport.scrollTop = 480;
    fireEvent.pointerDown(rightHandle!, { pointerId: 1, clientX: 320, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 300 });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("w=400px"));
    await waitFor(() => expect(previewViewport.scrollTop).toBe(480));
    expect(String(onChange.mock.lastCall?.[0])).not.toContain("h=");
    expect(screen.getByRole("button", { name: "Align preview center" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Align preview right" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("align=right"));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("```html preview"));
    fireEvent.click(screen.getByRole("button", { name: "Hide HTML preview" }));
    expect(screen.queryByTitle("HTML preview")).not.toBeInTheDocument();
    expect(surface).toHaveTextContent("Hello, world!");
    fireEvent.click(screen.getByRole("button", { name: "Show HTML preview" }));
    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument();
  });

  it("keeps an existing HTML preview mounted when an adjacent basic block is inserted", async () => {
    const initial = [
      "Before",
      "",
      "```html preview",
      "<p>Persistent preview</p>",
      "```",
    ].join("\n");

    function ControlledEditor() {
      const [text, setText] = useState(initial);
      const accepted = useRef(initial);
      return (
        <VisualMarkdownEditor
          text={text}
          activePath="notes.md"
          onChangeMarkdown={(next, expected) => {
            if (accepted.current !== expected) return false;
            accepted.current = next;
            setText(next);
            return true;
          }}
          onUndo={() => false}
          onRedo={() => false}
        />
      );
    }

    render(<ControlledEditor />);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const preview = await screen.findByTitle("HTML preview");
    const previewBlock = preview.closest(".ok-codeblock");
    const heading = editor.schema.nodes.heading.create(
      { level: 2 },
      editor.schema.text("Inserted basic block"),
    );

    act(() => {
      editor.view.dispatch(editor.state.tr.insert(editor.state.doc.firstChild!.nodeSize, heading));
    });

    await waitFor(() => expect(surface).toHaveTextContent("Inserted basic block"));
    expect(screen.getByTitle("HTML preview")).toBe(preview);
    expect(preview.closest(".ok-codeblock")).toBe(previewBlock);
  });

  it("keeps the slash query when an image prompt is cancelled", async () => {
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/image").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /Image/ }));
    // Upstream no longer prompts for a URL: Image is inserted canonically and
    // its node UI owns subsequent source editing.
    expect(prompt).not.toHaveBeenCalled();
    await waitFor(() => expect(editorMarkdown(editor)).not.toContain("/image"));
    await waitFor(
      () => expect(String(onChange.mock.lastCall?.[0])).toBe('<img src="" />'),
      { timeout: 2_500 },
    );
    prompt.mockRestore();
  });

  it("opens the emoji picker from the slash menu and inserts at the caret", async () => {
    const { onChange } = renderEditor("Hello");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus("end").insertContent(" /emoji").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /Emoji/ }));
    // The item deletes the trigger range, then raises the app-scope picker.
    // Query fresh inside waitFor: Radix re-mounts the popover content while
    // positioning, so a node captured earlier can go stale.
    await waitFor(() => {
      const popover = screen.getByTestId("emoji-picker-popover");
      expect(within(popover).getByPlaceholderText("Search emoji")).toBeInTheDocument();
    });
    await waitFor(() => expect(editorMarkdown(editor)).not.toContain("/emoji"));
    // Picking inserts plain Unicode at the caret and writes back one canonical update.
    onChange.mockClear();
    const { insertEmojiAtCaret } = await import("@ok-app/editor/components/EmojiInsertPopover");
    insertEmojiAtCaret(editor, "🎉");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("Hello 🎉"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("opens the URL field when Link is inserted from the slash menu", async () => {
    const { onChange } = renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/link").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /^Link/ }));
    const input = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("[link](https://example.com)"));
  });

  it("keeps path suggestions closed while a link field is empty", () => {
    render(
      <LinkPathSuggestionInput
        value=""
        pages={new Set()}
        folderPaths={new Set()}
        onValueChange={() => undefined}
        placeholder="Link URL"
        aria-label="Link URL"
      />,
    );
    fireEvent.focus(screen.getByRole("combobox", { name: "Link URL" }));
    expect(screen.queryByText("No matching paths")).not.toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Path suggestions" })).not.toBeInTheDocument();
  });

  it("renders a filled tag as a static chip, not an input", async () => {
    renderEditor("A #tag");
    const chip = await screen.findByRole("link", { name: "#tag" });
    expect(chip).toHaveClass("tag");
    expect(chip).toHaveAttribute("data-tag", "tag");
    expect(chip).toHaveAttribute("href", "#tag/tag");
    // The filled chip is read-only — editing happens by deleting the
    // atom and re-inserting, so no inline input may remain mounted.
    expect(screen.queryByRole("textbox", { name: "Tag value" })).not.toBeInTheDocument();
  });

  it("grows a placeholder Tag input with its draft and commits on Enter", async () => {
    const { onChange } = renderEditor("A");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.chain().focus().insertTag("").run();
    });
    const input = await screen.findByRole("textbox", { name: "Tag value" });
    expect(input).toHaveAttribute("size", "8");
    fireEvent.change(input, { target: { value: "research-notes" } });
    expect(input).toHaveAttribute("size", String("research-notes".length));
    // Invalid characters never enter the draft (INLINE_TAG_VALUE_RE gate).
    fireEvent.change(input, { target: { value: "research notes!" } });
    expect(input).toHaveValue("research-notes");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("#research-notes"));
    // Commit returns an inline textbox-less chip to the document.
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Tag value" })).not.toBeInTheDocument());
  });

  it("discards an empty tag placeholder on Escape", async () => {
    renderEditor("A");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.chain().focus().insertTag("").run();
    });
    const input = await screen.findByRole("textbox", { name: "Tag value" });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Tag value" })).not.toBeInTheDocument());
    // The placeholder atom deleted itself, returning the document to its
    // original state regardless of when deferred publication runs.
    expect(editor.getText()).toBe("A");
  });

  it("deletes a filled tag atom with a single Backspace", async () => {
    const { onChange } = renderEditor("A #tag");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.chain().focus("end").run();
    });
    fireEvent.keyDown(surface, { key: "Backspace" });
    await waitFor(() => {
      const last = String(onChange.mock.lastCall?.[0]);
      expect(last).not.toContain("#tag");
      expect(last.trim()).toBe("A");
    });
  });

  it("does not offer link editing when hovering a tag chip", async () => {
    renderEditor("A #tag");
    const chip = await screen.findByRole("link", { name: "#tag" });
    fireEvent.mouseOver(chip);
    // Outlast the 300ms hover dwell; the link hover card must stay away
    // (its Edit action opens the LINK popover, meaningless for a tag atom).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("button", { name: "Edit link" })).not.toBeInTheDocument();
  });

  it("creates a tag through the # typeahead", async () => {
    const { onChange } = renderEditor("See");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.chain().focus("end").insertContent(" #re").run();
    });
    const menu = await screen.findByRole("listbox", { name: "Tag suggestions" });
    const create = await within(menu).findByRole("option", { name: /re/ });
    fireEvent.mouseDown(create);
    await waitFor(() => expect(surface.querySelector('a.tag[data-tag="re"]')).not.toBeNull());
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("#re"));
  });

  it("edits and removes an existing Markdown link in place", async () => {
    const { onChange } = renderEditor("[Docs](https://old.example)");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const openLinkEditor = () => act(() => {
      editor.view.dispatch(editor.view.state.tr.setSelection(
        TextSelection.create(editor.view.state.doc, 1, 5),
      ));
      window.dispatchEvent(new CustomEvent("research-writer:visual-link-insert", {
        detail: { editor },
      }));
    });
    openLinkEditor();
    const input = await screen.findByRole("textbox", { name: "Link URL" });
    expect(input).toHaveValue("https://old.example");
    expect(screen.queryByRole("button", { name: "bold" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "https://new.example" } });
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    fireEvent.click(outside);
    outside.remove();
    expect(screen.queryByRole("textbox", { name: "Link URL" })).not.toBeInTheDocument();
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("[Docs](https://new.example)"));

    await screen.findByRole("link", { name: "Docs" });
    openLinkEditor();
    await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("Docs"));
    expect(screen.queryByRole("link", { name: "Docs" })).not.toBeInTheDocument();
  });

  it("mounts the fixed block drop indicator outside the clipped editor viewport", async () => {
    renderEditor("First\n\nSecond");
    const grip = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".visual-drag-grip");
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1 });
    await waitFor(() => {
      const dropLine = document.querySelector<HTMLElement>(".visual-block-drop-line");
      expect(dropLine).not.toBeNull();
      expect(dropLine?.parentElement).toBe(document.body);
    });
  });

  it("imports an image through the host project workflow", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    const onImportAsset = vi.fn(async () => "figures/uploaded.png");
    render(
      <VisualMarkdownEditor
        text=""
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
        onImportAsset={onImportAsset}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/image").run();
    const menu = await screen.findByRole("listbox", { name: "Slash commands" });
    fireEvent.mouseDown(within(menu).getByRole("option", { name: /^Image/ }));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose image to upload"]')!;
    const file = new File(["image"], "plot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(onImportAsset).toHaveBeenCalledWith(file));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe('<img src="figures/uploaded.png" />'));
  });

  it("keeps slash combobox relationships valid when no blocks match", async () => {
    renderEditor("");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus().insertContent("/no-such-block").run();
    expect(await screen.findByRole("status")).toHaveTextContent("No results");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    expect(surface).not.toHaveAttribute("aria-controls");
    expect(surface).not.toHaveAttribute("aria-activedescendant");
  });

  it("moves the current top-level block through the editor transaction", async () => {
    const { onChange } = renderEditor("First\n\nSecond");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.setTextSelection(8);
    expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Second\n\nFirst", "First\n\nSecond"));
  });

  it("reorders top-level blocks with the WebKit-safe pointer drag transaction", async () => {
    const { onChange } = renderEditor("First\n\nSecond\n\nThird");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const positions = new Map<string, number>();
    editor.state.doc.forEach((node, position) => positions.set(node.textContent, position));
    expect(moveTopLevelBlock(
      editor.state,
      editor.view.dispatch,
      positions.get("First")!,
      positions.get("Second")!,
      true,
    )).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(
      "Second\n\nFirst\n\nThird",
      "First\n\nSecond\n\nThird",
    ));
  });

  it("keeps an atomic block selected after moving it", async () => {
    const { onChange } = renderEditor("Before\n\n$$\nx\n$$\n\nAfter");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let mathPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "jsxComponent") mathPosition = position;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, mathPosition)));
    const propertiesButton = await screen.findByRole("button", { name: "Dollar Math properties" });
    const mathComponent = propertiesButton.closest(".jsx-component-wrapper");
    expect(mathComponent).not.toBeNull();
    expect(within(mathComponent as HTMLElement).queryByRole("button", { name: "Edit display equation" })).not.toBeInTheDocument();
    const toolbarButtons = within(mathComponent as HTMLElement).getAllByRole("button");
    expect(toolbarButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Dollar Math properties",
      "Delete Dollar Math",
    ]);
    expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.doc.nodeAt(editor.state.selection.from)?.type.name).toBe("jsxComponent");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("$$\nx\n$$\n\nBefore\n\nAfter"));
  });

  it("isolates unsupported blocks while keeping the surrounding document editable", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    renderEditor("Editable paragraph\n\n<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>", onChange);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => {
      // Upstream wildcard auto-convert: the unregistered component becomes a
      // rawMdxFallback whose nested CodeMirror holds the exact source bytes.
      expect(document.querySelector(".raw-mdx-fallback-wrapper")).toHaveTextContent("Exact source");
    });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toContain("<Unknown prop=\"x\">\n\nExact source\n\n</Unknown>");
  });

  it("renders a read-only MirrorSource from another indexed document and refreshes it", async () => {
    const workspaceIndex = new MarkdownWorkspaceIndex(async () => "");
    workspaceIndex.noteDocumentContent(
      "source.md",
      "<MirrorSource id=\"shared\">\n\n**First version**\n\n</MirrorSource>",
    );
    render(
      <VisualMarkdownEditor
        text={'<Mirror src="source" anchor="shared" />'}
        activePath="notes.md"
        workspaceIndex={workspaceIndex}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const mirror = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".ok-mirror-resolved");
      expect(element).not.toBeNull();
      return element!;
    });
    expect(mirror).toHaveTextContent("First version");
    expect(mirror.querySelector("strong")).not.toBeNull();

    act(() => workspaceIndex.noteDocumentContent(
      "source.md",
      "<MirrorSource id=\"shared\">\n\nSecond version\n\n</MirrorSource>",
    ));
    await waitFor(() => expect(mirror).toHaveTextContent("Second version"));
  });

  it.each([
    "````text\n```\n````",
    "~~~text\n```\n~~~",
  ])("keeps fence-sensitive code blocks visually editable with exact source", async (markdown) => {
    const { onChange } = renderEditor(`Editable\n\n${markdown}`);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(document.querySelector(".ok-codeblock")).not.toBeNull());
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Updated Editable\n\n${markdown}`);
  });

  it("renders and edits GFM tables as visual table cells", async () => {
    const { onChange } = renderEditor("| Left | Right |\n| :--- | ---: |\n| A | B |");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    expect(surface.querySelector("table")).not.toBeNull();
    expect(surface.querySelectorAll("th")).toHaveLength(2);
    expect(surface.querySelectorAll("td")).toHaveLength(2);
    expect(document.querySelector(".visual-markdown-raw-block")).toBeNull();
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let cellTextPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "A") cellTextPosition = position;
    });
    expect(cellTextPosition).toBeGreaterThan(0);
    editor.commands.insertContentAt(cellTextPosition, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toContain("Updated");
  });

  it("draws an Overleaf cursor inside the matching visual table cell", async () => {
    render(
      <VisualMarkdownEditor
        text={"| Left | Right |\n| --- | --- |\n| A | B |"}
        activePath="table-presence.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 2, column: 3 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")).not.toBeNull());
    const caret = document.querySelector<HTMLElement>(".visual-overleaf-caret")!;
    expect(caret.closest("td")).toHaveTextContent("A");
    expect(caret).not.toHaveAttribute("contenteditable");
    expect(caret).not.toHaveClass("ProseMirror-widget");
    expect(caret).toHaveAttribute("aria-hidden", "true");
  });

  it("places the local caret without blocking text selection in a cell occupied by an Overleaf cursor", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    render(
      <VisualMarkdownEditor
        text={"| Left | Right |\n| --- | --- |\n| A | B |"}
        activePath="table-presence-click.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 2, column: 3 }]}
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const caret = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".visual-overleaf-caret");
      expect(element).not.toBeNull();
      return element!;
    });
    const cell = caret.closest<HTMLTableCellElement>("td")!;
    let textPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "A") textPosition = position;
    });
    expect(textPosition).toBeGreaterThan(0);
    editor.commands.setTextSelection(1);
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: textPosition, inside: -1 });

    const selectionDragAllowed = fireEvent.mouseDown(cell, { button: 0, clientX: 20, clientY: 20 });
    const clickAllowed = fireEvent.click(cell, { button: 0, clientX: 20, clientY: 20 });

    expect(selectionDragAllowed).toBe(true);
    expect(clickAllowed).toBe(false);
    expect(editor.state.selection.from).toBe(textPosition);
    expect(editor.state.selection.$from.node(-1).type.spec.tableRole).toMatch(/cell/);
    editor.commands.insertContent("X");
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("XA"));
  });

  it("anchors an Overleaf delimiter-row cursor in the matching visual header cell", async () => {
    render(
      <VisualMarkdownEditor
        text={"| Left | Right |\n| --- | --- |\n| A | B |"}
        activePath="table-delimiter-presence.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 1, column: 3 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")).not.toBeNull());
    const caret = document.querySelector<HTMLElement>(".visual-overleaf-caret")!;
    expect(caret.closest("th")).toHaveTextContent("Left");
  });

  it.each([
    { markdown: "| A \\| B | C |\n| --- | --- |\n| x | y |", headerIndex: 0 },
    { markdown: "| | Right |\n| --- | --- |\n| x | y |", headerIndex: 0 },
    { markdown: "| Only |\n| --- |\n| x |", headerIndex: 0 },
  ])("maps delimiter cursors with escaped, empty, and one-column headers", async ({ markdown, headerIndex }) => {
    render(
      <VisualMarkdownEditor
        text={markdown}
        activePath="table-delimiter-edge-presence.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 1, column: 3 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")).not.toBeNull());
    const headers = document.querySelectorAll("th");
    expect(document.querySelector(".visual-overleaf-caret")?.closest("th")).toBe(headers[headerIndex]);
  });

  it("does not mistake a dash-only table body row for the delimiter", async () => {
    render(
      <VisualMarkdownEditor
        text={"| Left | Right |\n| --- | --- |\n| --- | --- |"}
        activePath="table-dash-body-presence.md"
        presenceCursors={[{ name: "Ada", hue: 210, row: 2, column: 3 }]}
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );

    await waitFor(() => expect(document.querySelector(".visual-overleaf-caret")).not.toBeNull());
    expect(document.querySelector(".visual-overleaf-caret")?.closest("td")).not.toBeNull();
  });

  it("deletes a block-selected table instead of clearing its cells", async () => {
    const markdown = "Before\n\n| Left | Right |\n| --- | --- |\n| A | B |\n\nAfter";
    const { onChange } = renderEditor(markdown);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let tablePosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "table") tablePosition = position;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, tablePosition)));

    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(surface.querySelector(".tableWrapper")).toHaveClass("ProseMirror-selectednode");
    expect(editor.commands.keyboardShortcut("Delete")).toBe(true);
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe("Before\n\nAfter"));
    expect(surface.querySelector("table")).toBeNull();
  });

  it("edits a supported GFM table without rewriting surrounding authored source", async () => {
    const source = "Authored  prose\n\n| Left | Right |\n| :--- | ---: |\n| A | B |";
    const { onChange } = renderEditor(source);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let position = -1;
    editor.state.doc.descendants((node, offset) => {
      if (node.isText && node.text === "A") position = offset;
    });
    editor.commands.insertContentAt(position, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0]).startsWith("Authored  prose\n\n")).toBe(true);
  });

  // An HTML comment reaches mdast without source positions, so the parser
  // cannot say which bytes belong to which block, and restoreUnchangedBlocks
  // has nothing it can safely splice. The two-space-indented paragraph after
  // the footnote definition is then a real rewrite — its leading spaces do not
  // survive the round trip — so the gate has to keep this document source-only.
  const UNMAPPABLE_MARKDOWN = "<!-- c -->\n\n[^n]: First paragraph.\n\n  Not a continuation.\n";

  it("keeps Markdown with an unmappable block structure source-only", async () => {
    renderEditor(UNMAPPABLE_MARKDOWN);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("unsupported or lossy syntax");
    expect(status).toHaveClass("visual-markdown-eligibility");
  });

  it("explains when paper Markdown is read-only to preserve lossy syntax", async () => {
    render(
      <VisualMarkdownEditor
        text={UNMAPPABLE_MARKDOWN}
        activePath=".research/papers/example/paper.md"
        optimizeForReading
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"));
    expect(screen.getByText("unsupported or lossy syntax", { exact: false })).toBeInTheDocument();
  });

  it("clears a stale eligibility warning after the same paper path becomes lossless", async () => {
    const renderPaper = (text: string) => (
      <VisualMarkdownEditor
        text={text}
        activePath=".research/papers/example/paper.md"
        optimizeForReading
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
      />
    );
    const view = render(renderPaper(UNMAPPABLE_MARKDOWN));
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "false"));

    view.rerender(renderPaper("A lossless paper body."));

    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
  });

  // Every arxiv2md paper opens on syntax the serializer would renormalize: a
  // `## Contents` heading sitting directly on its list, a bold caption sitting
  // directly on its table, `\*` escaping inside a caption. None of it is the
  // reader's typing, so none of it may cost them visual editing — or rewrite
  // the file underneath them on open.
  it.each([
    ["a heading tight against its list", "## Contents\n- 1 Introduction\n- 2 Approach\n"],
    ["a caption tight against its table", "**Table 1: Caption.**\n| A | B |\n| --- | --- |\n| 1 | 2 |\n"],
    ["a paragraph tight against its list", "Questions we answer:\n1) First\n2) Second\n"],
    ["a stray asterisk in prose", "The authors (1* and 2*) contributed equally.\n"],
    ["emphasis nested in a bold caption", "**Table 1: A *single* Flamingo model.**\n"],
    ["an indented paragraph after a footnote", "[^n]: First paragraph.\n\n  Not a continuation."],
  ])("keeps converter Markdown editable and byte-identical: %s", async (_label, markdown) => {
    const { onChange } = renderEditor(markdown);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    expect(screen.queryByText("unsupported or lossy syntax", { exact: false })).not.toBeInTheDocument();
    // Opening it may not publish a rewrite of syntax nobody touched.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("re-serializes only the edited block and leaves tight boundaries alone", async () => {
    const { onChange } = renderEditor("## Contents\n- 1 Introduction\n\nClosing prose.\n");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let closing = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "Closing prose.") closing = position;
    });
    editor.chain().focus().setTextSelection(closing + "Closing prose.".length).insertContent("!").run();

    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
    // The heading keeps sitting directly on its list; only the edited
    // paragraph went through the serializer.
    expect(String(onChange.mock.lastCall?.[0]))
      .toBe("## Contents\n- 1 Introduction\n\nClosing prose.!\n");
  });

  it("shows table controls for a collapsed cell cursor and preserves the GFM header row", async () => {
    const { onChange } = renderEditor("| Left | Right |\n| --- | --- |\n| A | B |");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let bodyCell = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "A") bodyCell = position;
    });
    editor.chain().focus().setTextSelection(bodyCell).run();

    const handles = await screen.findAllByTestId("table-cell-handle");
    expect(editor.state.selection.empty).toBe(true);
    expect(handles).toHaveLength(2);
    expect(handles[0]?.parentElement?.parentElement).toBe(document.body);
    expect(handles[0]?.parentElement).toHaveClass("is-visible");
    // jsdom gives floating-ui zero-sized rects, so its viewport middleware
    // correctly marks the portaled control hidden in tests. Query the hidden
    // control directly; browsers provide real geometry and reveal it.
    const rowOptions = handles[1]?.querySelector<HTMLButtonElement>("button");
    expect(rowOptions).toHaveAttribute("aria-label", "Row options");
    if (!rowOptions) throw new Error("Expected the row options control");
    fireEvent.pointerDown(rowOptions, { button: 0 });
    fireEvent.pointerUp(document);
    const insertRowBelow = await screen.findByRole("menuitem", { name: "Insert row below" });
    expect(insertRowBelow).toBeEnabled();
    fireEvent.click(insertRowBelow);
    await waitFor(() => expect(surface.querySelectorAll("tr")).toHaveLength(3));
    expect(surface.querySelectorAll("tr:first-child th")).toHaveLength(2);
    await waitFor(
      () => expect(String(onChange.mock.lastCall?.[0])).toMatch(/\| Left\s+\| Right\s+\|\n\| -+ \| -+ \|/),
      { timeout: 2_500 },
    );
  });

  it("uses Enter to move down a table column and appends a row at the bottom", async () => {
    const { onChange } = renderEditor("| Left | Right |\n| --- | --- |\n| A | B |");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let bodyCell = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "A") bodyCell = position;
    });
    editor.chain().focus().setTextSelection(bodyCell).run();
    fireEvent.keyDown(surface, { key: "Enter" });
    await waitFor(() => expect(surface.querySelectorAll("tr")).toHaveLength(3));
    expect(surface.querySelectorAll("tr:first-child th")).toHaveLength(2);
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2_500 });
  });

  it("moves down a column instead of splitting the cell when table text is selected", () => {
    // Upstream behavior: Enter with a non-empty in-cell selection still moves
    // to the row below (default Enter would delete the selection and split
    // the cell into an unrepresentable multi-paragraph shape).
    renderEditor("| Left | Right |\n| --- | --- |\n| A value | B |");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let textPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "A value") textPosition = position;
    });
    editor.chain().focus().setTextSelection({ from: textPosition, to: textPosition + 7 }).run();
    const tr = tableEnterDown(editor.state);
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    // The selected text survives and a fresh row is appended below.
    expect(editor.state.doc.textContent).toContain("A value");
    expect(surface.querySelectorAll("tr")).toHaveLength(3);
    expect(editor.state.selection.empty).toBe(true);
  });

  it("keeps thematic breaks and the prose between them visually editable", () => {
    renderEditor("Intro\n\n---\n\nMiddle\n\n---\n\nEnd");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    expect(surface).toHaveTextContent("Middle");
    expect(document.querySelector(".visual-markdown-raw-block")).toBeNull();
    fireEvent.click(surface.querySelector("hr")!);
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("preserves source-sensitive image syntax exactly when nearby prose changes", async () => {
    const source = "Before ![Plot](<../figures/my plot.png> \"Results\") after";
    const { onChange } = renderEditor(source);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Updated ${source}`);
  });

  it("collapses a typed $formula$ literal into an inline math atom", async () => {
    // Input rules fire only from handleTextInput, so type character by
    // character the way the DOM input path does (upstream test technique).
    const { onChange } = renderEditor("Start here: ");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus("end").run();
    for (const char of "$x+y$") {
      const { from, to } = editor.state.selection;
      const deflt = () => editor.state.tr.insertText(char, from, to);
      const handled = editor.view.someProp("handleTextInput", (handleTextInput) =>
        handleTextInput(editor.view, from, to, char, deflt),
      );
      if (!handled) editor.view.dispatch(deflt());
    }
    // The rule collapses the completed literal a microtask after the closing $.
    await waitFor(() => {
      let found = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === "mathInline" && node.attrs.formula === "x+y") found = true;
      });
      expect(found).toBe(true);
    });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("$x+y$"));
  });

  it("collapses a typed [label](url) literal into a link", async () => {
    const { onChange } = renderEditor("See ");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.chain().focus("end").run();
    for (const char of "[docs](https://example.com)") {
      const { from, to } = editor.state.selection;
      const deflt = () => editor.state.tr.insertText(char, from, to);
      const handled = editor.view.someProp("handleTextInput", (handleTextInput) =>
        handleTextInput(editor.view, from, to, char, deflt),
      );
      if (!handled) editor.view.dispatch(deflt());
    }
    await waitFor(() => {
      const link = surface.querySelector('a[href="https://example.com"]');
      expect(link).not.toBeNull();
      expect(link).toHaveTextContent("docs");
    });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain("[docs](https://example.com)"));
  });

  it("renders inline math without disabling visual editing", async () => {
    renderEditor("The result is $x^2$.");
    expect(screen.getByRole("textbox", { name: "Markdown document editor" })).toHaveAttribute("contenteditable", "true");
    // Upstream MathInlineView lazily imports KaTeX and renders inside the
    // click-to-edit trigger span.
    await waitFor(() => {
      expect(document.querySelector(".math-inline-trigger .katex")).not.toBeNull();
    });
  });

  it("keeps dollar-denominated prices as prose", async () => {
    renderEditor("It costs $5 and then $10 more.");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    expect(surface).toHaveTextContent("It costs $5 and then $10 more.");
    expect(document.querySelector(".math-inline-trigger")).toBeNull();
  });

  it("preserves single-dollar inline math inside converted list prose", () => {
    const markdown = "- •\n  No positional information.\n- •\n  One-dimensional embeddings.\n- •\n  Two axes use $X$ and $Y$, each with size $D/2$.\n- •\n  Relative positional embeddings.\n";
    const parsed = parseVisualMarkdown(markdown, "paper.md");
    const serialized = preserveMarkdownEnvelope(getMarkdownManager().serialize(parsed), markdown);
    expect(canonicalizeSupportedMarkdown(serialized)).toBe(canonicalizeSupportedMarkdown(markdown));
  });

  it("opens converter-normalized paper Markdown directly in visual mode", async () => {
    const source = "## Contents\n\n- Intro\n\n<a id=\"eq\"></a>\n\n$$\nx_{p} \\%\n$$\n\n- •\n  Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$.\n";
    renderEditor(source);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    expect(screen.queryByText(/Visual editing is unavailable/)).toBeNull();
  });

  it("preserves authored LaTeX escapes in untouched inline math", async () => {
    const source = "Accuracy is $88.55\\%$ and the state is $\\mathbf{x}_{p}$ here.";
    const { onChange } = renderEditor(source);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Reported ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Reported ${source}`);
  });

  it("edits a dollar-delimited equation in place", async () => {
    const { onChange } = renderEditor("The result is $x^2$.");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(document.querySelector(".math-inline-trigger")).not.toBeNull());
    // Upstream flow: a NodeSelection on the atom (click / slash-insert)
    // opens the PropPanel popover anchored to it.
    let atomPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "mathInline") atomPosition = position;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, atomPosition)));
    const input = await screen.findByRole("textbox", { name: /formula/i });
    // Formula edits stay local until the author confirms them.
    fireEvent.change(input, { target: { value: "y^3" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("The result is $y^3$.", "The result is $x^2$."));
  });

  it("keeps the inline math editor open while a formula is typed character by character", async () => {
    function ControlledEditor() {
      const [text, setText] = useState("The result is $x$.");
      return (
        <VisualMarkdownEditor
          text={text}
          activePath="notes.md"
          onChangeMarkdown={(next, expected) => {
            if (text !== expected) return false;
            setText(next);
            return true;
          }}
          onUndo={() => false}
          onRedo={() => false}
        />
      );
    }

    render(<ControlledEditor />);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(document.querySelector(".math-inline-trigger")).not.toBeNull());
    let atomPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "mathInline") atomPosition = position;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, atomPosition)));

    for (const formula of ["a", "ab", "abc", "abc+1"]) {
      const input = await screen.findByRole("textbox", { name: /formula/i });
      fireEvent.change(input, { target: { value: formula } });
      await waitFor(() => expect(screen.getByRole("textbox", { name: /formula/i })).toHaveValue(formula));
      await waitFor(() => expect(document.querySelector(".math-inline-trigger")).toHaveAttribute("data-formula", formula));
    }
    expect(editor.state.doc.nodeAt(atomPosition)?.attrs.formula).toBe("x");
    fireEvent.keyDown(screen.getByRole("textbox", { name: /formula/i }), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /formula/i })).not.toBeInTheDocument());
    expect(editor.state.doc.nodeAt(atomPosition)?.attrs.formula).toBe("abc+1");
  });

  // The vendored Open Knowledge pipeline recognizes only dollar-delimited
  // math; \( \) and \[ \] stay editable plain text with exact source bytes.
  // Live rendering for LaTeX-delimited math is a known regression pending a
  // product decision (see thread notes).
  it.each([
    "The result is \\(x^2\\).",
    "\\[\nx^2 + y^2\n\\]",
  ])("preserves LaTeX-delimited math bytes when nearby prose changes", async (markdown) => {
    const { onChange } = renderEditor(`Editable\n\n${markdown}`);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toContain(markdown);
  });

  it("renders Mermaid as a normal code block with a preview toggle", async () => {
    renderEditor("```mermaid\ngraph TD; A-->B\n```");
    expect(screen.getByRole("textbox", { name: "Markdown document editor" })).toBeInTheDocument();
    const block = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.ok-codeblock[data-language="mermaid"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(block).toHaveAttribute("data-code-visible", "false");
    expect(screen.getByRole("button", { name: "Code block language: Mermaid. Click to change." })).toBeInTheDocument();
    const initialPreview = await screen.findByRole("group", { name: "Mermaid preview" });
    expect(initialPreview).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Mermaid preview" }));
    expect(screen.queryByRole("group", { name: "Mermaid preview" })).not.toBeInTheDocument();
    expect(block).toHaveAttribute("data-code-visible", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show Mermaid preview" }));
    const preview = await screen.findByRole("group", { name: "Mermaid preview" });
    expect(preview).toBeInTheDocument();
    const previewWrapper = preview.closest<HTMLElement>(".ok-codeblock-preview");
    expect(previewWrapper).toHaveClass("ok-codeblock-preview--mermaid");
    expect(previewWrapper!.querySelector(".ok-resize-handle--l")).not.toBeNull();
    expect(previewWrapper!.querySelector(".ok-resize-handle--r")).not.toBeNull();
    expect(previewWrapper!.querySelector(".ok-resize-handle--b")).toBeNull();
    expect(block).toHaveAttribute("data-code-visible", "false");
    expect(block).toHaveTextContent("graph TD; A-->B");
  });

  it("opens a plain HTML fence as a visual preview by default", async () => {
    renderEditor("```html\n<p>Visual by default</p>\n```");
    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument();
    expect(document.querySelector('.ok-codeblock[data-language="html"]')).toHaveAttribute(
      "data-code-visible",
      "false",
    );
    expect(screen.getByRole("button", { name: "Hide HTML preview" })).toBeInTheDocument();
  });

  it("offers Mermaid in the code block language picker", async () => {
    const { onChange } = renderEditor("```text\ngraph TD; A-->B\n```");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Code block language: Plain text. Click to change.",
      }),
    );
    fireEvent.change(await screen.findByPlaceholderText("Filter languages"), {
      target: { value: "Mermaid" },
    });
    fireEvent.click(await screen.findByRole("option", { name: "Mermaid" }));
    expect(await screen.findByRole("group", { name: "Mermaid preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide Mermaid preview" })).toBeInTheDocument();
    await waitFor(() =>
      expect(String(onChange.mock.lastCall?.[0])).toBe("```mermaid\ngraph TD; A-->B\n```"),
    );
  });

  it("keeps Mermaid source editable as an ordinary fenced code block", async () => {
    const { onChange } = renderEditor("```mermaid\ngraph TD; A-->B\n```");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let sourcePos = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "graph TD; A-->B") sourcePos = position;
    });
    expect(sourcePos).toBeGreaterThan(-1);
    editor.view.dispatch(
      editor.state.tr.replaceWith(
        sourcePos,
        sourcePos + "graph TD; A-->B".length,
        editor.schema.text("graph LR; B-->C"),
      ),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(
      "```mermaid\ngraph LR; B-->C\n```",
      "```mermaid\ngraph TD; A-->B\n```",
    ));
  });

  it("edits a source-preserved Markdown block in place through the nested source editor", async () => {
    const { onChange } = renderEditor("Before\n\n<Unknown>\n\nExact source\n\n</Unknown>");
    // Upstream wildcard path: unregistered JSX auto-converts into a
    // rawMdxFallback rendered as an embedded CodeMirror source editor.
    const wrapper = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".raw-mdx-fallback-wrapper");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(wrapper).toHaveAttribute("role", "group");
    expect(wrapper).toHaveAccessibleName("Unknown component: Unknown");
    const cmContent = await waitFor(() => {
      const el = wrapper.querySelector<HTMLElement>(".cm-content");
      expect(el).not.toBeNull();
      return el!;
    });
    const cmView = CMEditorView.findFromDOM(cmContent)!;
    expect(cmView.state.doc.toString()).toBe("<Unknown>\n\nExact source\n\n</Unknown>");
    // The auto-convert itself serializes byte-identically — no writeback.
    expect(onChange).not.toHaveBeenCalled();
    cmView.dispatch({
      changes: {
        from: 0,
        to: cmView.state.doc.length,
        insert: "<Unknown>\n\nUpdated source\n\n</Unknown>",
      },
    });
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toBe(
      "Before\n\n<Unknown>\n\nUpdated source\n\n</Unknown>",
    ));
  });

  it("reconciles a remote edit into the nested source editor without writing back", async () => {
    const onChange = vi.fn<(next: string, expected: string) => boolean>(() => true);
    const { rerender } = renderEditor("Before\n\n<Unknown>\n\nOriginal\n\n</Unknown>", onChange);
    await waitFor(() => {
      expect(document.querySelector(".raw-mdx-fallback-wrapper .cm-content")).not.toBeNull();
    });
    rerender(
      <VisualMarkdownEditor
        text={"Before\n\n<Unknown>\n\nRemote\n\n</Unknown>"}
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    // Remote canonical replace reconciles into the nested CodeMirror…
    await waitFor(() => {
      const cmContent = document.querySelector<HTMLElement>(".raw-mdx-fallback-wrapper .cm-content");
      expect(cmContent).not.toBeNull();
      expect(CMEditorView.findFromDOM(cmContent!)!.state.doc.toString()).toContain("Remote");
    });
    // …and never triggers an onChange writeback.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves math, Mermaid fences, and raw blocks when nearby prose changes", async () => {
    const markdown = [
      "Editable paragraph",
      "",
      "The value is $x + y$.",
      "",
      "```MerMaid",
      "graph TD; A-->B",
      "```",
      "",
      "[^note]: Keep  two spaces",
    ].join("\n");
    const { onChange } = renderEditor(markdown);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => {
      // Language casing is preserved while the fence stays a plain code block.
      expect(document.querySelector('.ok-codeblock[data-language="MerMaid"]')).not.toBeNull();
      // Upstream footnote UI: core renderHTML emits the auto-numbered
      // aside with the fn-{id} anchor and the ↩ back-reference.
      expect(document.querySelector("aside.footnote-def#fn-note")).not.toBeNull();
      expect(document.querySelector('a.footnote-backref[href="#fnref-note"]')).not.toBeNull();
    });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = String(onChange.mock.lastCall?.[0]);
    expect(next).toContain("$x + y$");
    expect(next).toContain("```MerMaid\ngraph TD; A-->B\n```");
    expect(next).toContain("[^note]: Keep  two spaces");
  });

  it.each([
    ["reference links", "Read [Results][paper].\n\n[paper]: results.md \"Title\""],
    ["inline HTML", "Press <kbd class=\"key\">&copy;</kbd> now."],
    ["raw-text HTML", "Code <script>a && b</script> after."],
    ["HTML entity", "Copyright &copy; 2026."],
    ["block HTML", "<aside data-kind=\"note\">Exact HTML</aside>"],
  ])("preserves %s exactly when nearby prose changes", async (_label, specialSource) => {
    const { onChange } = renderEditor(`Editable paragraph\n\n${specialSource}`);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Updated Editable paragraph\n\n${specialSource}`);
  });

  it("does not turn standalone inline HTML into a separate Markdown block", async () => {
    const source = "Editable\n\nBefore\n<kbd>Ctrl</kbd>\nAfter";
    const { onChange } = renderEditor(source);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(surface).toHaveAttribute("contenteditable", "true"));
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Updated ${source}`);
  });

  it.each([
    // Both nonstandard casing and metadata-bearing Mermaid fences stay code blocks.
    ["~~~~MerMaid\ngraph TD; A-->B\n~~~~~", '.ok-codeblock[data-language="MerMaid"]'],
    ["````mermaid title=flow\ngraph TD; A-->B\n`````", '.ok-codeblock[data-language="mermaid"]'],
  ])("renders nonstandard Mermaid fences visually and preserves their source", async (source, selector) => {
    const { onChange } = renderEditor(`Editable\n\n${source}`);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(`Updated Editable\n\n${source}`);
  });

  it("exposes and visibly selects atomic visual content", async () => {
    renderEditor("Before $x$ after");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(document.querySelector(".math-inline-trigger")).not.toBeNull());
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    let atomPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "mathInline") atomPosition = position;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, atomPosition)));
    expect(document.querySelector(".math-inline-trigger")!.closest(".ProseMirror-selectednode")).not.toBeNull();
  });

  it("delegates history to the canonical document", async () => {
    const onUndo = vi.fn(() => true);
    const onRedo = vi.fn(() => true);
    const onChange = vi.fn(() => true);
    const { rerender } = render(
      <VisualMarkdownEditor
        text="Initial"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );
    rerender(
      <VisualMarkdownEditor
        text="External"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveTextContent("External"));
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.keyboardShortcut("Mod-z");
    editor.commands.keyboardShortcut("Mod-Shift-z");
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onRedo).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses the last accepted Markdown for rapid consecutive visual edits", async () => {
    const { onChange } = renderEditor("Start");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.setContent("First", { contentType: "markdown" });
    editor.commands.setContent("Second", { contentType: "markdown" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Second", "Start"));
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("preserves an IME draft across a remote canonical update at compositionend", async () => {
    const onChange = vi.fn(() => false);
    const { rerender } = renderEditor("Original", onChange);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    fireEvent.compositionStart(surface);
    await replaceEditorText("完整的本地草稿");
    rerender(
      <VisualMarkdownEditor
        text="Remote canonical"
        activePath="notes.md"
        onChangeMarkdown={onChange}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    expect(surface).toHaveTextContent("完整的本地草稿");
    fireEvent.compositionEnd(surface);
    // The failure is reported through the app's notifications rather than as a
    // bar inside the document, and it carries both ways out of it.
    await waitFor(() => expect(notifications.error).toHaveBeenCalled());
    await waitFor(() => expect(surface).toHaveTextContent("Remote canonical"));
    const options = notifications.error.mock.calls.at(-1)![2];
    expect(options.copyText).toBe("完整的本地草稿");
    expect(options.timeoutMs).toBe(0);
    act(() => { void options.primaryAction.onClick(); });
    expect(surface).toHaveTextContent("完整的本地草稿");
  });

  it("preserves CRLF and a final newline while editing visually", async () => {
    const { onChange } = renderEditor("Hello\r\n");
    await replaceEditorText("Changed");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Changed\r\n", "Hello\r\n"));
  });

  it("opens relative project links on an ordinary click", async () => {
    const onOpenProjectPath = vi.fn();
    render(
      <VisualMarkdownEditor
        text="[Details](details.md)"
        activePath="notes/index.md"
        onChangeMarkdown={() => true}
        onOpenProjectPath={onOpenProjectPath}
        onUndo={() => false}
        onRedo={() => false}
      />,
    );
    const link = await screen.findByRole("link", { name: "Details" });
    fireEvent.click(link);
    expect(onOpenProjectPath).toHaveBeenCalledWith("notes/details.md");
  });

  it("round-trips Markdown images instead of dropping them on the first edit", async () => {
    const { onChange } = renderEditor("Before ![Plot](figures/plot.png \"Results\") after");
    expect(await screen.findByRole("img", { name: "Plot" })).toHaveAttribute("src", "/figures/plot.png");
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.insertContentAt(1, "Updated ");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toContain('![Plot](figures/plot.png "Results")');
  });

  it("loads a project-relative Markdown image through the host asset reader", async () => {
    const onLoadAsset = vi.fn(async () => "data:image/png;base64,cGxvdA==");
    render(
      <VisualMarkdownEditor
        text="![Plot](../figures/plot.png)"
        activePath="notes/results.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
        onLoadAsset={onLoadAsset}
      />,
    );
    const image = await screen.findByRole("img", { name: "Plot" });
    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith("figures/plot.png"));
    await waitFor(() => expect(image).toHaveAttribute("src", "data:image/png;base64,cGxvdA=="));
    expect(image).toHaveAttribute("decoding", "async");
  });

  it.each(["above", "below", "far below"] as const)(
    "keeps a loaded Markdown image visible when the plus action inserts %s it",
    async (side) => {
      const initial = [
        "Before",
        "![Plot](figures/plot.png)",
        "After",
        "Far 1",
        "Far 2",
        "Far 3",
        "Far 4",
        "Far 5",
      ].join("\n\n");
      const onLoadAsset = vi.fn(async () => "data:image/png;base64,cGxvdA==");
      function ControlledEditor() {
        const [text, setText] = useState(initial);
        const accepted = useRef(initial);
        return (
          <VisualMarkdownEditor
            text={text}
            activePath="notes.md"
            onChangeMarkdown={(next, expected) => {
              if (accepted.current !== expected) return false;
              accepted.current = next;
              setText(next);
              return true;
            }}
            onLoadAsset={onLoadAsset}
            onUndo={() => false}
            onRedo={() => false}
          />
        );
      }

      render(<ControlledEditor />);
      const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
      const editor = (surface as HTMLElement & { editor: Editor }).editor;
      let canonicalReplacements = 0;
      const dispatch = editor.view.dispatch.bind(editor.view);
      vi.spyOn(editor.view, "dispatch").mockImplementation((transaction) => {
        if (transaction.getMeta("canonicalMarkdownReplace")) canonicalReplacements += 1;
        dispatch(transaction);
      });
      await screen.findByRole("img", { name: "Plot" });
      await waitFor(() => expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
        "src",
        "data:image/png;base64,cGxvdA==",
      ));
      fireEvent.load(screen.getByRole("img", { name: "Plot" }));
      await waitFor(() => expect(screen.queryByTestId("image-loading-skeleton")).not.toBeInTheDocument());
      const image = screen.getByRole("img", { name: "Plot" });
      let imagePosition = -1;
      let farPosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "jsxComponent" && node.attrs.componentName === "CommonMarkImage") {
          imagePosition = position;
        }
        if (node.type.name === "paragraph" && node.textContent === "Far 5") farPosition = position;
      });
      expect(imagePosition).toBeGreaterThanOrEqual(0);
      expect(farPosition).toBeGreaterThan(imagePosition);
      const targetPosition = side === "above"
        ? 0
        : side === "below"
          ? imagePosition
          : farPosition;
      const target = editor.state.doc.nodeAt(targetPosition);
      expect(target).not.toBeNull();

      act(() => addBlockBelow(editor, targetPosition, target!));

      expect(screen.getByRole("img", { name: "Plot" })).toBe(image);
      expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      expect(canonicalReplacements).toBe(0);
      expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
        "src",
        "data:image/png;base64,cGxvdA==",
      );
      expect(screen.getByRole("img", { name: "Plot" })).toBe(image);
      expect(screen.getByRole("img", { name: "Plot" })).toHaveClass("opacity-100");
      expect(screen.queryByTestId("image-loading-skeleton")).not.toBeInTheDocument();
      expect(onLoadAsset).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps existing Mermaid and HTML previews mounted after a controlled Markdown echo", async () => {
    const initial = [
      "Before",
      "```mermaid\ngraph TD; A-->B\n```",
      "```html preview\n<p>Persistent HTML</p>\n```",
      "Tail",
    ].join("\n\n");
    function ControlledEditor() {
      const [text, setText] = useState(initial);
      const accepted = useRef(initial);
      return (
        <VisualMarkdownEditor
          text={text}
          activePath="notes.md"
          onChangeMarkdown={(next, expected) => {
            if (accepted.current !== expected) return false;
            accepted.current = next;
            setText(next);
            return true;
          }}
          onUndo={() => false}
          onRedo={() => false}
        />
      );
    }

    render(<ControlledEditor />);
    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    const mermaid = await screen.findByRole("group", { name: "Mermaid preview" });
    const html = await screen.findByTitle("HTML preview");
    let tailPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.textContent === "Tail") tailPosition = position;
    });
    expect(tailPosition).toBeGreaterThanOrEqual(0);
    const tail = editor.state.doc.nodeAt(tailPosition);
    expect(tail).not.toBeNull();

    act(() => addBlockBelow(editor, tailPosition, tail!));

    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(screen.getByRole("group", { name: "Mermaid preview" })).toBe(mermaid);
    expect(screen.getByTitle("HTML preview")).toBe(html);
  });

  it("loads an Open Knowledge image component through the host asset reader", async () => {
    const onLoadAsset = vi.fn(async () => "data:image/png;base64,YmxvY2s=");
    render(
      <VisualMarkdownEditor
        text={'<img src="../figures/block.png" alt="Block" />'}
        activePath="notes/results.md"
        onChangeMarkdown={() => true}
        onUndo={() => false}
        onRedo={() => false}
        onLoadAsset={onLoadAsset}
      />,
    );
    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith("figures/block.png"));
    expect(await screen.findByRole("img", { name: "Block" })).toHaveAttribute(
      "src",
      "data:image/png;base64,YmxvY2s=",
    );
  });

  it("keeps image alignment in the hover toolbar instead of the selection bubble", async () => {
    const { onChange } = renderEditor("![Plot](figures/plot.png)");
    const image = await screen.findByRole("img", { name: "Plot" });
    const component = image.closest<HTMLElement>("[data-jsx-component]");
    expect(component).not.toBeNull();

    fireEvent.mouseOver(component!);
    expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Align right" }));
    await waitFor(() => expect(String(onChange.mock.lastCall?.[0])).toContain('align="right"'));
    expect(String(onChange.mock.lastCall?.[0])).toContain('src="figures/plot.png"');
    expect(String(onChange.mock.lastCall?.[0])).not.toContain("sourceUrl=");

    const surface = screen.getByRole("textbox", { name: "Markdown document editor" });
    const editor = (surface as HTMLElement & { editor: Editor }).editor;
    editor.commands.setNodeSelection(0);
    for (const bubbleMenu of screen.queryAllByTestId("bubble-menu-bar")) {
      expect(within(bubbleMenu).queryByRole("button", { name: "Align right" })).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Image properties" }));
    await waitFor(() => expect(document.querySelector("[data-prop-panel]")).not.toBeNull());
    expect(document.querySelector("[data-prop-panel-advanced-trigger]")).toBeNull();
    expect(screen.queryByText("Align")).not.toBeInTheDocument();
  });

  it("resizes a Markdown image and persists its dimensions as an HTML image", async () => {
    const { onChange } = renderEditor("![Plot](figures/plot.png \"Results\")");
    const image = await screen.findByRole("img", { name: "Plot" });
    const wrapper = image.closest<HTMLElement>(".ok-image-resizable");
    expect(wrapper).not.toBeNull();
    vi.spyOn(wrapper!, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 320,
      bottom: 240,
      width: 320,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(wrapper!.querySelector(".ok-resize-handle--br")).toBeNull();
    const handle = wrapper!.querySelector<HTMLElement>(".ok-resize-handle--r");
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle!, { pointerId: 1, clientX: 320, clientY: 240 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 300 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toContain('width={400}');
    expect(String(onChange.mock.lastCall?.[0])).not.toContain('height=');
    expect(String(onChange.mock.lastCall?.[0])).toContain('src="figures/plot.png"');
    expect(String(onChange.mock.lastCall?.[0])).toContain('alt="Plot"');
    expect(String(onChange.mock.lastCall?.[0])).toContain('title="Results"');
  });
});
