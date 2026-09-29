/**
 * The Lattice visual engine's editing chrome, driven as a reader uses it
 * (spec R-CHR-1–5, R-CHR-7, R-FMT-1/3/4/14/15/16/17/18, R-INL-3/6/7, R-BLK-19).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../../../app-types";
import { activateAppLocale } from "../../../i18n";
import { beginPaperDrag, PAPER_DRAG_TYPE } from "../../../papers/paper-drag";
import { MarkdownWorkspaceIndex } from "../markdown-workspace-index";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { moveBlockDown, moveBlockTo, moveBlockUp } from "./block-moves";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";
import { clearLinkPreviews } from "./chrome/link-preview";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@tauri-apps/api/core")>()), invoke }));

type Props = VisualMarkdownEditorProps;
type ChangeMock = ReturnType<typeof vi.fn<Props["onChangeMarkdown"]>>;

const surface = () => screen.getByRole("textbox", { name: /Markdown document editor|Markdown 文档编辑器/ }) as HTMLElement & { editor: Editor };

function renderEditor(props: Partial<Props> | string = {}) {
  const onChange: ChangeMock = vi.fn<Props["onChangeMarkdown"]>(() => true);
  const given = typeof props === "string" ? { text: props } : props;
  const current: Props = { text: "", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true, ...given };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return { ...view, onChange: (given.onChangeMarkdown ?? onChange) as ChangeMock, get editor() { return surface().editor; } };
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

/** Routes typed text through handleTextInput like the DOM input path, so input rules and menus fire. */
function type(editor: Editor, text: string, chunk = false) {
  act(() => {
    for (const piece of chunk ? [text] : [...text]) {
      const { from, to } = editor.state.selection;
      const insert = () => editor.state.tr.insertText(piece, from, to);
      if (!editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, piece, insert))) editor.view.dispatch(insert());
    }
  });
}

function caret(editor: Editor, position: number, head = position) {
  act(() => {
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position, head)));
  });
}

async function openSlash(editor: Editor, query = "") {
  caret(editor, editor.state.doc.content.size - 1);
  type(editor, `/${query}`);
  return screen.findByRole("listbox", { name: /Slash commands|斜杠命令/ });
}

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  clearLinkPreviews();
  await activateAppLocale("en");
});

describe("slash menu (R-CHR-1, §12)", () => {
  it.each([2, 5])("filters as the query grows and inserts Heading %i without the query", async (level) => {
    const { editor, onChange } = renderEditor("");
    const menu = await openSlash(editor, `h${level}`);
    expect(menu).toHaveTextContent(`Heading ${level}`);
    expect(menu).not.toHaveTextContent("Heading 1");
    fireEvent.mouseDown(within(menu).getByRole("option", { name: new RegExp(`Heading ${level}`) }));
    await waitFor(() => expect(editor.isActive("heading", { level })).toBe(true));
    expect(editor.getText()).not.toContain(`/h${level}`);
    // An empty ATX heading is its marker alone.
    await waitFor(() => expect(lastChange(onChange)).toBe("#".repeat(level)));
  });

  it("offers the kept insertions only, and unmounts cleanly while open", async () => {
    const { editor, unmount } = renderEditor("");
    const menu = await openSlash(editor);
    for (const name of [/Heading 1/, /Heading 6/, /Task List/, /Code Block/, /^Table/, /^Footnote/, /Inline Math/, /^Link/, /^Callout/, /^Accordion/, /^Mermaid/, /^Image/, /^Emoji/]) {
      expect(within(menu).getByRole("option", { name })).toBeInTheDocument();
    }
    for (const name of [/^Tabs/, /^Toggle/, /^Mirror/, /Align/, /^HTML/, /^Video/, /^Audio/, /^Tag/]) {
      expect(within(menu).queryByRole("option", { name })).not.toBeInTheDocument();
    }
    expect(() => unmount()).not.toThrow();
  });

  it("lists every item in Chinese with the four group headings", async () => {
    await activateAppLocale("zh-CN");
    const menu = await openSlash(renderEditor("").editor);
    expect(within(menu).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "一级标题", "二级标题", "三级标题", "四级标题", "五级标题", "六级标题", "无序列表", "有序列表", "任务列表", "引文",
      "代码块", "表格", "分隔线", "脚注", "表情符号", "行内公式", "链接", "提示框", "折叠面板", "数学", "Mermaid 图表", "图片",
    ]);
    for (const group of ["基础块", "插入", "组件", "媒体"]) expect(within(menu).getByText(group)).toBeInTheDocument();
    fireEvent.mouseEnter(within(menu).getByRole("option", { name: "二级标题" }));
    await waitFor(() => expect(document.querySelector(".lx-md-menu-preview")).toHaveTextContent("用于次级章节的中标题。"));
  });

  it("shares one active option between hover and arrows, and drops the combobox relationships with no match", async () => {
    const { editor } = renderEditor("");
    const menu = await openSlash(editor);
    const option = (name: RegExp) => within(menu).getByRole("option", { name });
    fireEvent.mouseEnter(option(/Heading 2/));
    await waitFor(() => expect(option(/Heading 2/)).toHaveAttribute("aria-selected", "true"));
    expect(document.querySelector(".lx-md-menu-preview")).toHaveTextContent("Medium section heading.");
    expect(surface()).toHaveAttribute("aria-activedescendant", option(/Heading 2/).id);
    fireEvent.keyDown(surface(), { key: "ArrowDown" });
    await waitFor(() => expect(option(/Heading 3/)).toHaveAttribute("aria-selected", "true"));
    type(editor, "no-such-block");
    expect(await screen.findByRole("status")).toHaveTextContent("No results");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    expect(surface()).not.toHaveAttribute("aria-controls");
    expect(surface()).not.toHaveAttribute("aria-activedescendant");
  });

  it.each([
    ["a canonical callout", "callout", /^Callout/, "<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>"],
    ["an empty image without prompting", "image", /^Image/, "<img src=\"\" />"],
  ])("inserts %s", async (_label, query, option, expected) => {
    const { editor, onChange } = renderEditor("");
    fireEvent.mouseDown(within(await openSlash(editor, query)).getByRole("option", { name: option }));
    await waitFor(() => expect(lastChange(onChange)).toBe(expected));
  });

  it("imports an image through the host and writes its path relative to the note", async () => {
    const onImportAsset = vi.fn(async () => "figures/uploaded.png");
    const { editor, onChange } = renderEditor({ text: "", activePath: "notes/index.md", onImportAsset });
    fireEvent.mouseDown(within(await openSlash(editor, "image")).getByRole("option", { name: /^Image/ }));
    const file = new File(["image"], "plot.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose image to upload"), { target: { files: [file] } });
    await waitFor(() => expect(onImportAsset).toHaveBeenCalledWith(file));
    await waitFor(() => expect(lastChange(onChange)).toBe("<img src=\"../figures/uploaded.png\" />"));
  });

  it("opens the file dialog again after one is dismissed, and inserts where the caret's place moved to during the import", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    let finish: (path: string) => void = () => undefined;
    const onImportAsset = vi.fn(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));
    const { editor } = renderEditor({ text: "Hello", onImportAsset });
    const chooseImage = async () => {
      caret(editor, editor.state.doc.content.size - 1);
      type(editor, " /image");
      fireEvent.mouseDown(within(await screen.findByRole("listbox", { name: "Slash commands" })).getByRole("option", { name: /^Image/ }));
    };
    await chooseImage();
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const input = screen.getByLabelText("Choose image to upload");
    fireEvent(input, new Event("cancel"));
    await chooseImage();
    await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
    fireEvent.change(input, { target: { files: [new File(["image"], "plot.png", { type: "image/png" })] } });
    await waitFor(() => expect(onImportAsset).toHaveBeenCalledTimes(1));
    caret(editor, 1);
    type(editor, "Big ", true);
    await act(async () => finish("figures/plot.png"));
    await waitFor(() => expect(nodePos(editor, (node) => node.type.name === "image")).toBeGreaterThan(0));
    const image = nodePos(editor, (node) => node.type.name === "image");
    expect(editor.state.doc.textBetween(0, image)).toBe("Big Hello  ");
    click.mockRestore();
  });

  it("opens the emoji picker without the query and inserts Unicode at the caret", async () => {
    const { editor } = renderEditor("Hello");
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " /emoji");
    fireEvent.mouseDown(within(await screen.findByRole("listbox", { name: "Slash commands" })).getByRole("option", { name: /^Emoji/ }));
    const picker = await screen.findByTestId("emoji-picker-popover");
    expect(within(picker).getByPlaceholderText("Search emoji")).toBeInTheDocument();
    await waitFor(() => expect(editor.getText()).toBe("Hello "));
    fireEvent.keyDown(within(picker).getByPlaceholderText("Search emoji"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("emoji-picker-popover")).toBeNull());
  });

  it("inserts a link placeholder and opens its URL field", async () => {
    const { editor, onChange } = renderEditor("");
    fireEvent.mouseDown(within(await openSlash(editor, "link")).getByRole("option", { name: /^Link/ }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Link URL" }), { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("[link](https://example.com)"));
  });

  it.each([["math", /^Math/, "Formula"], ["inline", /Inline Math/, "Formula"]])("inserts an empty %s formula with its field open", async (query, option, field) => {
    const { editor } = renderEditor("");
    fireEvent.mouseDown(within(await openSlash(editor, query)).getByRole("option", { name: option }));
    expect(await screen.findByRole("textbox", { name: field })).toBeInTheDocument();
  });

  it("inserts a footnote reference with a definition to write the note in", async () => {
    const { editor, onChange } = renderEditor("Claim");
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " /footnote");
    fireEvent.mouseDown(within(await screen.findByRole("listbox", { name: "Slash commands" })).getByRole("option", { name: /^Footnote/ }));
    type(editor, "Source.");
    await waitFor(() => expect(lastChange(onChange)).toBe("Claim [^1]\n\n[^1]: Source."));
  });
});

describe("selection toolbar (R-CHR-2, R-FMT-1)", () => {
  it.each([
    ["Bold", "**Hello**"],
    ["Italic", "*Hello*"],
    ["Underline", "<u>Hello</u>"],
    ["Strikethrough", "~~Hello~~"],
    ["Inline code", "`Hello`"],
    ["Highlight", "==Hello=="],
    ["Convert selection to inline math", "$Hello$"],
  ])("writes %s from the toolbar", async (name, expected) => {
    const { editor, onChange } = renderEditor("Hello");
    caret(editor, 1, 6);
    fireEvent.mouseDown(await screen.findByRole("button", { name }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected, "Hello"));
  });

  it("formats CJK text, labelled in the interface language", async () => {
    await activateAppLocale("zh-CN");
    const { editor, onChange } = renderEditor("中文格式测试");
    caret(editor, 1, 3);
    expect(await screen.findByRole("toolbar", { name: "格式" })).toBeInTheDocument();
    for (const name of ["块类型", "粗体", "斜体", "下划线", "删除线", "行内代码", "高亮", "插入链接", "将所选文字转换为脚注", "将所选文字转换为行内公式"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.mouseDown(screen.getByRole("button", { name: "粗体" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("**中文**格式测试", "中文格式测试"));
  });

  it("offers twelve block types in three groups, marks the active one, and applies Heading 5", async () => {
    const { editor } = renderEditor("Hello");
    caret(editor, 1, 6);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Block type" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(12);
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);
    expect(within(menu).getByRole("menuitem", { name: "Text" })).toHaveAttribute("data-active");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Heading 5" }));
    await waitFor(() => expect(editor.isActive("heading", { level: 5 })).toBe(true));
  });

  it("converts a selection to a footnote whose note holds the text", async () => {
    const { editor, onChange } = renderEditor("Claim evidence here");
    caret(editor, 7, 15);
    fireEvent.mouseDown(await screen.findByRole("button", { name: "Convert selection to footnote" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("Claim [^1] here\n\n[^1]: evidence"));
  });

  it("hides when the editor loses focus", async () => {
    const { editor } = renderEditor("Hello");
    caret(editor, 1, 6);
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => outside.focus());
    fireEvent.blur(surface(), { relatedTarget: outside });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument());
    outside.remove();
  });
});

describe("links (R-FMT-4, R-CHR-4, R-INL-3)", () => {
  it("edits a link's URL in place, commits on an outside click, and removes it", async () => {
    const { editor, onChange } = renderEditor("[Docs](https://old.example)");
    caret(editor, 2);
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    const url = await screen.findByRole("combobox", { name: "Link URL" });
    expect(url).toHaveValue("https://old.example");
    fireEvent.change(url, { target: { value: "https://new.example" } });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(lastChange(onChange)).toBe("[Docs](https://new.example)"));
    caret(editor, 2);
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("Docs"));
  });

  it("suggests project pages relative to the note as a path is typed, never for an empty field", async () => {
    const workspaceIndex = new MarkdownWorkspaceIndex(async (path) => (path === "notes/results.md" ? "# Results\n" : "# Ideas\n"));
    await workspaceIndex.update(["notes/results.md", "ideas.md"].map((path) => ({ name: path, path, kind: "file", contentKind: "text", children: [] })));
    const { editor, onChange } = renderEditor({ text: "See results", activePath: "notes/index.md", workspaceIndex });
    caret(editor, 5, 12);
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    const url = await screen.findByRole("combobox", { name: "Link URL" });
    expect(screen.queryByRole("listbox", { name: "Path suggestions" })).toBeNull();
    fireEvent.change(url, { target: { value: "idea" } });
    const list = await screen.findByRole("listbox", { name: "Path suggestions" });
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["../ideas.mdIdeas"]);
    fireEvent.keyDown(url, { key: "ArrowDown" });
    expect(url).toHaveAttribute("aria-activedescendant", within(list).getByRole("option").id);
    fireEvent.keyDown(url, { key: "Enter" });
    expect(url).toHaveValue("../ideas.md");
    expect(screen.queryByRole("listbox", { name: "Path suggestions" })).toBeNull();
    fireEvent.keyDown(url, { key: "Enter" });
    await waitFor(() => expect(lastChange(onChange)).toBe("See [results](../ideas.md)"));
  });

  it("refuses a script URL", async () => {
    const { editor, onChange } = renderEditor("[Docs](https://old.example)");
    caret(editor, 2);
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    fireEvent.change(await screen.findByRole("combobox", { name: "Link URL" }), { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("collapses a typed Markdown link", async () => {
    const { editor, onChange } = renderEditor("See");
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " [docs](https://example.com)");
    expect(surface().querySelector("a[href=\"https://example.com\"]")).toHaveTextContent("docs");
    await waitFor(() => expect(lastChange(onChange)).toBe("See [docs](https://example.com)"));
  });

  it("previews after a dwell, offers Edit link for project links without fetching, and closes after leaving", async () => {
    vi.useFakeTimers();
    try {
      renderEditor("[Notes](./notes.md) and [Site](https://example.com/article)");
      const project = screen.getByRole("link", { name: "Notes" });
      fireEvent.mouseOver(project);
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(document.querySelector(".lx-md-link-card")).toHaveTextContent("./notes.md");
      expect(screen.getByRole("button", { name: "Edit link" })).toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
      fireEvent.mouseOut(project);
      await act(() => vi.advanceTimersByTimeAsync(150));
      expect(document.querySelector(".lx-md-link-card")).toBeNull();
      invoke.mockResolvedValue({ ok: true, metadata: { domain: "example.com", title: "Example title", faviconDataUri: "https://example.com/favicon.png" } });
      fireEvent.mouseOver(screen.getByRole("link", { name: "Site" }));
      await act(() => vi.advanceTimersByTimeAsync(300));
      expect(invoke).toHaveBeenCalledWith("link_preview", { url: "https://example.com/article" });
      expect(document.querySelector(".lx-md-link-card")).toHaveTextContent("Example title");
      expect(document.querySelector(".lx-md-link-card img")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("find and replace (R-CHR-3)", () => {
  it("finds case-insensitively, moves on Enter, and clears on Escape", async () => {
    const { editor } = renderEditor("Alpha beta alpha.");
    const projectFind = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    surface().dispatchEvent(projectFind);
    expect(projectFind.defaultPrevented).toBe(false);
    expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
    caret(editor, 1);
    fireEvent.keyDown(surface(), { key: "f", ctrlKey: true });
    const find = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.change(find, { target: { value: "alpha" } });
    await waitFor(() => expect(within(screen.getByRole("search")).getByRole("status")).toHaveTextContent("1 of 2"));
    expect(document.querySelectorAll(".lx-md-find-match")).toHaveLength(2);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(within(screen.getByRole("search")).getByRole("status")).toHaveTextContent("2 of 2");
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("search", { name: "Find in document" })).toBeNull();
    expect(document.querySelectorAll(".lx-md-find-match")).toHaveLength(0);
  });

  it("opens with Replace from a short selection and replaces every match", async () => {
    const { editor, onChange } = renderEditor("one two one");
    caret(editor, 1, 4);
    fireEvent.keyDown(surface(), { key: "f", altKey: true, ctrlKey: true });
    expect(await screen.findByRole("searchbox", { name: "Find" })).toHaveValue("one");
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "three" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("three two three"));
  });

  it("disables replacing in a document that cannot be edited", async () => {
    renderEditor({ text: "one two", editable: false });
    fireEvent.keyDown(surface(), { key: "f", altKey: true, ctrlKey: true });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find" }), { target: { value: "one" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace all matches" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Replace current match" })).toBeDisabled();
  });

  it("keeps match offsets in the original text after a letter whose lowercase is longer", async () => {
    const { editor, onChange } = renderEditor("İstanbul alpha");
    caret(editor, 1);
    fireEvent.keyDown(surface(), { key: "f", altKey: true, ctrlKey: true });
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find" }), { target: { value: "ALPHA" } });
    await waitFor(() => expect(within(screen.getByRole("search")).getByRole("status")).toHaveTextContent("1 of 1"));
    expect(document.querySelector(".lx-md-find-match")).toHaveTextContent(/^alpha$/);
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("İstanbul beta"));
  });
});

describe("block moves (R-FMT-15, R-FMT-16)", () => {
  async function moved(text: string, place: (editor: Editor) => void, command: (editor: Editor) => boolean) {
    const { editor, onChange } = renderEditor(text);
    place(editor);
    act(() => {
      expect(command(editor)).toBe(true);
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    return { editor, text: lastChange(onChange) };
  }

  it.each([
    ["a top-level block up", "First\n\nSecond", "Second", "up", "Second\n\nFirst"],
    ["a list item, keeping the prose around it", "Before\n\n- Alpha\n- Bravo longer\n\nAfter", "Bravo longer", "up", "Before\n\n- Bravo longer\n- Alpha\n\nAfter"],
    ["a task item with its checkbox", "Before\n\n- [ ] Alpha\n- [x] Bravo longer\n- [ ] Charlie\n\nAfter", "Bravo longer", "up", "Before\n\n- [x] Bravo longer\n- [ ] Alpha\n- [ ] Charlie\n\nAfter"],
    ["a nested item within its parent", "- Parent\n  - Alpha\n  - Bravo longer\n- Other", "Bravo longer", "up", "- Parent\n  - Bravo longer\n  - Alpha\n- Other"],
  ])("moves %s", async (_label, source, text, direction, expected) => {
    const result = await moved(source, (editor) => caret(editor, nodePos(editor, text) + 1), (editor) => (direction === "up" ? moveBlockUp : moveBlockDown)(editor.state, editor.view.dispatch));
    expect(result.text).toBe(expected);
  });

  it("renumbers an ordered list from its authored start when items move", async () => {
    const { editor, onChange } = renderEditor("7. Alpha\n8. Bravo longer\n9. Charlie\n10. Delta");
    caret(editor, nodePos(editor, "Alpha") + 1, nodePos(editor, "Bravo longer") + 3);
    act(() => {
      expect(moveBlockDown(editor.state, editor.view.dispatch)).toBe(true);
    });
    await waitFor(() => expect(lastChange(onChange)).toBe("7. Charlie\n8. Alpha\n9. Bravo longer\n10. Delta"));
  });

  it("never moves a list whole at its edges or joins two lists", () => {
    const { editor } = renderEditor("Before\n\n- Alpha\n- Bravo longer\n\nBetween\n\n- Charlie\n\nAfter");
    caret(editor, nodePos(editor, "Alpha") + 1);
    expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(false);
    caret(editor, nodePos(editor, "Bravo longer") + 1);
    expect(moveBlockDown(editor.state, editor.view.dispatch)).toBe(false);
    const alpha = editor.state.doc.resolve(nodePos(editor, "Alpha")).before();
    const charlie = editor.state.doc.resolve(nodePos(editor, "Charlie")).before();
    expect(moveBlockTo(editor.state, editor.view.dispatch, alpha, charlie, false)).toBe(false);
  });

  it("keeps a moved formula selected and its bytes", async () => {
    const { editor, onChange } = renderEditor("Before\n\n$$\nx\n$$\n\nAfter");
    const position = nodePos(editor, (node) => node.type.name === "latticeMathBlock");
    act(() => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position))));
    act(() => {
      expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    await waitFor(() => expect(lastChange(onChange)).toBe("$$\nx\n$$\n\nBefore\n\nAfter"));
  });

  it("moves the paragraph around a selected inline formula, never the formula within its text", async () => {
    const result = await moved("Before\n\nHello world $x$", (editor) => {
      const formula = nodePos(editor, (node) => node.type.name === "latticeMath");
      act(() => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, formula))));
    }, (editor) => moveBlockUp(editor.state, editor.view.dispatch));
    expect(result.text).toBe("Hello world $x$\n\nBefore");
    expect((result.editor.state.selection as NodeSelection).node.type.name).toBe("latticeMath");
  });

  it("drags selected list items together, then moves another by keyboard", async () => {
    const { editor, onChange } = renderEditor("- Alpha\n- Bravo longer\n- Charlie\n- Delta");
    caret(editor, nodePos(editor, "Alpha") + 1, nodePos(editor, "Bravo longer") + 3);
    const item = (text: string) => editor.state.doc.resolve(nodePos(editor, text)).before(-1);
    act(() => {
      expect(moveBlockTo(editor.state, editor.view.dispatch, item("Alpha"), item("Delta"), true)).toBe(true);
    });
    await waitFor(() => expect(lastChange(onChange)).toBe("- Charlie\n- Delta\n- Alpha\n- Bravo longer"));
    caret(editor, nodePos(editor, "Delta") + 1);
    act(() => {
      expect(moveBlockUp(editor.state, editor.view.dispatch)).toBe(true);
    });
    await waitFor(() => expect(lastChange(onChange)).toBe("- Delta\n- Charlie\n- Alpha\n- Bravo longer"));
  });

  it("drops a block after another through the pointer transaction", async () => {
    const { editor, onChange } = renderEditor("First\n\nSecond\n\nThird");
    const first = 0;
    const second = editor.state.doc.child(0).nodeSize;
    act(() => {
      expect(moveBlockTo(editor.state, editor.view.dispatch, first, second, true)).toBe(true);
    });
    await waitFor(() => expect(lastChange(onChange)).toBe("Second\n\nFirst\n\nThird"));
  });
});

describe("block controls (R-CHR-5)", () => {
  const setRect = (element: Element, rect: DOMRect) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
  const pressGrip = (grip: HTMLElement, clientY = 0) => {
    fireEvent.pointerDown(grip, { button: 0, clientY });
    fireEvent.pointerUp(window, { clientY });
  };

  it("offers Add block below and Select block for a hovered block, and adds a slash line", async () => {
    const { editor } = renderEditor("First\n\nSecond");
    const blocks = [...surface().children];
    setRect(blocks[0]!, new DOMRect(100, 100, 400, 28));
    setRect(blocks[1]!, new DOMRect(100, 156, 400, 28));
    fireEvent.mouseMove(blocks[1]!, { clientX: 150, clientY: 170 });
    pressGrip(await screen.findByRole("button", { name: "Select block" }));
    expect((editor.state.selection as NodeSelection).node?.textContent).toBe("Second");
    fireEvent.mouseMove(blocks[0]!, { clientX: 150, clientY: 112 });
    fireEvent.click(await screen.findByRole("button", { name: "Add block below" }));
    expect(editor.state.doc.child(1).textContent).toBe("/");
    expect(editor.state.selection.$from.parentOffset).toBe(1);
    expect(await screen.findByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
  });

  it.each(["ltr", "rtl"])("keeps a list item's grip reachable across its marker gutter (%s)", async (direction) => {
    const { editor } = renderEditor("Before\n\n98. Alpha\n99. Bravo\n100. Charlie\n\nAfter");
    surface().style.direction = direction;
    const list = surface().querySelector("ol")!;
    const items = [...list.children];
    setRect(surface().children[0]!, new DOMRect(100, 80, 400, 28));
    setRect(list, new DOMRect(100, 120, 400, 120));
    setRect(surface().children[2]!, new DOMRect(100, 260, 400, 28));
    items.forEach((item, index) => setRect(item, new DOMRect(140, 120 + index * 36, 320, 28)));
    fireEvent.mouseMove(items[1]!.querySelector("p")!, { clientX: 250, clientY: 170 });
    const grip = await screen.findByRole("button", { name: "Select list item" });
    expect(screen.queryByRole("button", { name: "Add block below" })).toBeNull();
    // On the way to the grip the pointer crosses the marker gutter on the item's row.
    const gutterX = direction === "rtl" ? 480 : 120;
    fireEvent.mouseMove(list, { clientX: gutterX, clientY: 170 });
    expect(screen.getByRole("button", { name: "Select list item" })).toBe(grip);
    pressGrip(grip);
    expect((editor.state.selection as NodeSelection).node?.textContent).toBe("Bravo");
    // Off that row, the gutter offers the whole list.
    fireEvent.mouseMove(list, { clientX: gutterX, clientY: 130 });
    expect(await screen.findByRole("button", { name: "Select numbered list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add block below" })).toBeInTheDocument();
  });

  it("drags a list item as a ghost in its own type, dropping only within its list and end gap", async () => {
    const { onChange } = renderEditor("Before\n\n- Alpha\n- Bravo longer\n- Charlie\n\nAfter");
    const list = surface().querySelector("ul")!;
    const items = [...list.children] as HTMLElement[];
    setRect(surface(), new DOMRect(100, 80, 400, 220));
    setRect(surface().children[0]!, new DOMRect(100, 80, 400, 28));
    setRect(list, new DOMRect(100, 120, 400, 84));
    setRect(surface().children[2]!, new DOMRect(100, 260, 400, 28));
    items.forEach((item, index) => setRect(item, new DOMRect(140, 120 + index * 28, 360, 28)));
    const paragraph = items[0]!.querySelector("p")!;
    fireEvent.mouseMove(paragraph, { clientX: 200, clientY: 130 });
    const grip = await screen.findByRole("button", { name: "Select list item" });
    const computed = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const style = computed(element);
      if (element === paragraph) Object.assign(style, { fontSize: "13px", lineHeight: "21px" });
      return style;
    });
    fireEvent.pointerDown(grip, { button: 0, clientY: 130 });
    fireEvent.pointerMove(window, { clientY: 208 });
    styles.mockRestore();
    expect(document.querySelector(".lx-md-drag-ghost p")).toHaveStyle({ fontSize: "13px", lineHeight: "21px" });
    const line = document.querySelector<HTMLElement>(".lx-md-drop-line")!;
    expect(line.parentElement).toBe(document.body);
    expect(line.hidden).toBe(false);
    // The following prose is not a drop zone for a list item.
    fireEvent.pointerMove(window, { clientY: 270 });
    expect(line.hidden).toBe(true);
    fireEvent.pointerMove(window, { clientY: 208 });
    fireEvent.pointerUp(window, { clientY: 208 });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\n- Bravo longer\n- Charlie\n- Alpha\n\nAfter"));
    expect(document.querySelector(".lx-md-drag-ghost, .lx-md-drop-line")).toBeNull();
  });

  it("moves the block around the caret with Mod-Shift-Up", async () => {
    const { editor, onChange } = renderEditor("First\n\nSecond");
    caret(editor, nodePos(editor, "Second") + 2);
    fireEvent.keyDown(surface(), { key: "ArrowUp", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(lastChange(onChange)).toBe("Second\n\nFirst"));
  });
});

describe("typed structure (R-BLK-19, R-FMT-14)", () => {
  const taskItems = (editor: Editor) => {
    const items: PmNode[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "taskItem") items.push(node);
    });
    return items;
  };

  it.each([
    ["[] ", false, null],
    ["[ ] ", false, null],
    ["[x] ", true, null],
    ["[X] ", true, "X"],
    ["- [ ] ", false, null],
  ] as const)("turns typed %j into one task item", (marker, checked, recorded) => {
    const { editor } = renderEditor("");
    caret(editor, 1);
    type(editor, marker);
    expect(taskItems(editor)).toHaveLength(1);
    expect(taskItems(editor)[0]!.attrs).toMatchObject({ checked, marker: recorded });
    expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
    expect(editor.state.doc.textContent).toBe("");
  });

  it.each([["- [] ", false], ["- [ ] ", false], ["* [x] ", true]] as const)("takes %j delivered in one IME chunk", (marker, checked) => {
    const { editor } = renderEditor("");
    caret(editor, 1);
    type(editor, marker, true);
    expect(taskItems(editor)[0]?.attrs.checked).toBe(checked);
    expect(editor.state.doc.textContent).toBe("");
  });

  it("reverts to the literal text on Backspace right after the rule", () => {
    const { editor } = renderEditor("");
    caret(editor, 1);
    type(editor, "[x] ");
    fireEvent.keyDown(surface(), { key: "Backspace" });
    expect(taskItems(editor)).toHaveLength(0);
    expect(editor.state.doc.textContent).toBe("[x] ");
  });

  it("makes a new task item from a continuation paragraph without retagging its item", () => {
    const { editor } = renderEditor("- first\n\n  continued");
    const continuation = nodePos(editor, "continued");
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(continuation, continuation + "continued".length));
    });
    caret(editor, continuation);
    type(editor, "[ ] ");
    const list = editor.state.doc.firstChild!;
    expect(list.children.map((item) => item.type.name)).toEqual(["listItem", "taskItem"]);
  });
});

describe("citations (R-INL-7, R-FMT-17)", () => {
  const PAPERS: PaperSummary[] = [
    { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true, hasBlog: true },
    { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "vaswani2017attention", hasFullText: true, hasBlog: true },
    { arxivId: "2010.11929", title: "An Image is Worth 16x16 Words", citationKey: "dosovitskiy2021image", hasFullText: false, hasBlog: true },
    { arxivId: "", title: "Cited Only Work", citationKey: "cited2020only", hasFullText: false, hasBlog: false },
  ] as PaperSummary[];
  const openCitations = async (editor: Editor, typed: string) => {
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, typed);
    return screen.findByRole("listbox", { name: "Paper citation suggestions" });
  };

  it("offers papers with local content, preselects the first, and accepts with Tab", async () => {
    const { editor, onChange } = renderEditor({ text: "Before", papers: PAPERS });
    const menu = await openCitations(editor, " @");
    const options = within(menu).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining("Attention Is All You Need"), expect.stringContaining("An Image is Worth")]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(surface(), { key: "ArrowDown" });
    await waitFor(() => expect(options[1]).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(surface(), { key: "Tab" });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before [An Image is Worth 16x16 Words](.research/papers/2010.11929/blog.md)"));
  });

  it("links relative to a nested note, filters on every word, and says when nothing matches", async () => {
    const { editor, onChange } = renderEditor({ text: "See", activePath: "notes/reading.md", papers: PAPERS });
    const menu = await openCitations(editor, " @attention need");
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(surface(), { key: "Enter" });
    await waitFor(() => expect(lastChange(onChange)).toBe("See [Attention Is All You Need](../.research/papers/1706.03762/paper.md)"));
    type(editor, "@nonexistent");
    expect(await screen.findByRole("status")).toHaveTextContent("No matching papers");
    expect(screen.queryByRole("listbox", { name: "Paper citation suggestions" })).toBeNull();
  });

  it("deletes a citation chip whole and edits it through Edit link", async () => {
    const source = "Before [Attention](.research/papers/1706.03762/paper.md) after";
    const { editor, onChange } = renderEditor({ text: source, papers: PAPERS });
    const chip = nodePos(editor, (node) => node.type.name === "latticeCitation");
    act(() => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, chip))));
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    const title = await screen.findByRole("textbox", { name: "Citation title" });
    expect(title).toHaveValue("Attention");
    fireEvent.change(title, { target: { value: "My reading notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), { target: { value: ".research/papers/1706.03762/blog.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("Before [My reading notes](.research/papers/1706.03762/blog.md) after"));
    caret(editor, chip + 1);
    fireEvent.keyDown(surface(), { key: "Backspace" });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before  after"));
  });

  it("turns a chip into an ordinary link for a safe external URL and refuses a script URL", async () => {
    const { editor, onChange } = renderEditor({ text: "[Attention](.research/papers/1706.03762/paper.md)", papers: PAPERS });
    const chip = nodePos(editor, (node) => node.type.name === "latticeCitation");
    act(() => editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, chip))));
    act(() => {
      editor.commands.keyboardShortcut("Mod-k");
    });
    const url = await screen.findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(url, { target: { value: "https://example.com/paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("[Attention](https://example.com/paper)"));
  });

  it("drops a paper as a @key citation at the pointer, ignoring other projects and read-only documents", async () => {
    const { editor, onChange } = renderEditor({ text: "Before after", activePath: "notes/reading.md", projectRoot: "/project", papers: PAPERS });
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 8, inside: 0 });
    const values = new Map<string, string>();
    const data = { types: [PAPER_DRAG_TYPE], setData: (key: string, value: string) => { values.set(key, value); }, getData: (key: string) => values.get(key) ?? "" } as unknown as DataTransfer;
    beginPaperDrag(data, "/project", PAPERS[0]!);
    fireEvent.drop(editor.view.dom, { dataTransfer: data, clientX: 20, clientY: 20 });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before [@vaswani2017attention](../.research/papers/1706.03762/paper.md)after"));
    onChange.mockClear();
    beginPaperDrag(data, "/other-project", PAPERS[2]!);
    fireEvent.drop(editor.view.dom, { dataTransfer: data });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("wiki links (R-INL-6, R-FMT-18)", () => {
  async function workspace() {
    const index = new MarkdownWorkspaceIndex(async (path) => ({
      "notes/results.md": "# Results\n\n## Accuracy\n\n## Accuracy\n",
      "ideas.md": "# Ideas\n",
    } as Record<string, string>)[path] ?? "");
    await index.update(["notes/results.md", "ideas.md"].map((path) => ({ name: path, path, kind: "file", contentKind: "text", children: [] })));
    return index;
  }

  it("offers pages as [[ is typed and writes the page's document name", async () => {
    const workspaceIndex = await workspace();
    const { editor, onChange } = renderEditor({ text: "See", workspaceIndex });
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " [[res");
    const menu = await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    expect(within(menu).getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(surface(), { key: "Enter" });
    await waitFor(() => expect(lastChange(onChange)).toBe("See [[notes/results]]"));
  });

  it("offers a page's headings after #, with their duplicate slugs", async () => {
    const workspaceIndex = await workspace();
    const { editor, onChange } = renderEditor({ text: "See", workspaceIndex });
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " [[notes/results#acc");
    const menu = await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    expect(within(menu).getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(surface(), { key: "ArrowDown" });
    fireEvent.keyDown(surface(), { key: "Enter" });
    await waitFor(() => expect(lastChange(onChange)).toBe("See [[notes/results#accuracy-1]]"));
  });

  it("closes at a typed ]] so the prose after a complete link is never taken as its query", async () => {
    const workspaceIndex = await workspace();
    const { editor } = renderEditor({ text: "See", workspaceIndex });
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " [[ideas");
    await screen.findByRole("listbox", { name: "Wiki link suggestions" });
    type(editor, "]] ideas");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Wiki link suggestions" })).toBeNull());
    fireEvent.keyDown(surface(), { key: "Enter" });
    expect(editor.getText()).toContain("See [[ideas]] ideas");
    // The typed link itself is one wiki link; the prose after it stays text.
    const link = nodePos(editor, (node) => node.type.name === "latticeWikiLink");
    expect(editor.state.doc.nodeAt(link)?.attrs.target).toBe("ideas");
    expect(nodePos(editor, " ideas")).toBe(link + 1);
  });

  it("makes a link to a page that does not exist yet when it is typed in full", async () => {
    const workspaceIndex = await workspace();
    const { editor, onChange } = renderEditor({ text: "See", workspaceIndex });
    caret(editor, editor.state.doc.content.size - 1);
    type(editor, " [[New Page]] about notes");
    await waitFor(() => expect(lastChange(onChange)).toBe("See [[New Page]] about notes"));
    expect(editor.state.doc.nodeAt(nodePos(editor, (node) => node.type.name === "latticeWikiLink"))?.attrs.target).toBe("New Page");
  });

  it("opens the linked page on Mod-click", async () => {
    const workspaceIndex = await workspace();
    const onOpenProjectPath = vi.fn();
    renderEditor({ text: "See [[ideas]] now", workspaceIndex, onOpenProjectPath });
    const link = await waitFor(() => {
      const element = surface().querySelector("[data-lattice-wiki]");
      expect(element).not.toBeNull();
      return element!;
    });
    fireEvent.click(link, { metaKey: true });
    await waitFor(() => expect(onOpenProjectPath).toHaveBeenCalledWith("ideas.md"));
  });
});
