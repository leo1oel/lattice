/**
 * The rich blocks of the Lattice visual engine, driven through the editor as a
 * reader uses them (spec R-BLK, R-FMT, R-INL-2, R-PUB-18, R-PUB-22).
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Node as PmNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "./lattice-visual-editor";
import { engineHealth } from "./views/view-chrome";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg viewBox=\"0 0 100 100\"><g><text>Graph</text></g></svg>" })),
  },
}));
const panzoom = vi.hoisted(() => ({ create: vi.fn(() => ({ pan: vi.fn(), zoomIn: vi.fn(), zoomOut: vi.fn(), reset: vi.fn(), destroy: vi.fn() })) }));
vi.mock("@panzoom/panzoom", () => ({ default: panzoom.create }));

type Props = VisualMarkdownEditorProps;
type ChangeMock = ReturnType<typeof vi.fn<Props["onChangeMarkdown"]>>;

const PNG = "data:image/png;base64,cGxvdA==";
const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };

function renderEditor(props: Partial<Props> | string = {}) {
  const onChange: ChangeMock = vi.fn<Props["onChangeMarkdown"]>(() => true);
  const given = typeof props === "string" ? { text: props } : props;
  let current: Props = { text: "", activePath: "notes.md", onChangeMarkdown: onChange, onUndo: () => true, onRedo: () => true, ...given };
  const view = render(<LatticeVisualMarkdownEditor {...current} />);
  return {
    ...view,
    onChange: (given.onChangeMarkdown ?? onChange) as ChangeMock,
    rerender: (next: Partial<Props>) => view.rerender(<LatticeVisualMarkdownEditor {...(current = { ...current, ...next })} />),
    get editor() { return surface().editor; },
  };
}

const lastChange = (onChange: ChangeMock) => String(onChange.mock.lastCall?.[0]);
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** Position of the first node matching `match` (a text value, or a predicate). */
function nodePos(editor: Editor, match: string | ((node: PmNode) => boolean)): number {
  let found = -1;
  editor.state.doc.descendants((node, position) => {
    if (found < 0 && (typeof match === "string" ? node.isText && node.text === match : match(node))) found = position;
    return found < 0;
  });
  return found;
}
const typePos = (editor: Editor, type: string) => nodePos(editor, (node) => node.type.name === type);
const selectNode = (editor: Editor, position: number) => act(() => {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)));
});
const setCaret = (editor: Editor, position: number) => act(() => {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
});
const insertAt = (editor: Editor, position: number, text: string) => act(() => {
  editor.view.dispatch(editor.state.tr.insertText(text, position));
});

/** Routes typed text through handleTextInput like the DOM input path, so input rules fire. */
function typeText(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    if (!editor.view.someProp("handleTextInput", (handle) => handle(editor.view, from, to, character, insert))) editor.view.dispatch(insert());
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A host that accepts every publication, so each `text` prop is the editor's own echo. */
function ControlledEditor({ initial, ...props }: Partial<Props> & { initial: string }) {
  const [text, setText] = useState(initial);
  const accepted = useRef(initial);
  return (
    <LatticeVisualMarkdownEditor
      activePath="notes.md"
      onUndo={() => true}
      onRedo={() => true}
      {...props}
      text={text}
      onChangeMarkdown={(next, expected) => {
        if (accepted.current !== expected) return false;
        accepted.current = next;
        setText(next);
        return true;
      }}
    />
  );
}

describe("rich views across edits and file switches (R-PUB-8, R-PUB-10, R-PUB-21)", () => {
  it("keeps a Mermaid preview and a loaded image mounted across adjacent inserts and their echoes", async () => {
    const onLoadAsset = vi.fn(async () => PNG);
    render(<ControlledEditor initial={["Before", "```mermaid\ngraph TD; A-->B\n```", "![Plot](figures/plot.png)", "Tail"].join("\n\n")} onLoadAsset={onLoadAsset} />);
    const preview = await screen.findByRole("group", { name: "Mermaid preview" });
    const image = await screen.findByRole("img", { name: "Plot" });
    const { editor } = surface();
    act(() => {
      editor.view.dispatch(editor.state.tr.insert(editor.state.doc.firstChild!.nodeSize, editor.schema.nodes.heading!.create({ level: 2 }, editor.schema.text("Inserted"))));
    });
    await waitFor(() => expect(surface()).toHaveTextContent("Inserted"));
    await settle(500);
    expect(screen.getByRole("group", { name: "Mermaid preview" })).toBe(preview);
    expect(screen.getByRole("img", { name: "Plot" })).toBe(image);
    expect(onLoadAsset).toHaveBeenCalledTimes(1);
  });

  it("switches files busy and read-only until the new file is shown, without lifecycle warnings", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderEditor({ text: "First\n", activePath: "a.md", onLoadAsset: async () => PNG });
    view.rerender({ text: "![Plot](figures/plot.png)\n\n$$\nx\n$$\n", activePath: "b.md" });
    const root = surface().closest(".lx-md-editor")!;
    expect(root).toHaveAttribute("aria-busy", "true");
    expect(surface()).toHaveAttribute("contenteditable", "false");
    await screen.findByRole("img", { name: "Plot" });
    expect(root).not.toHaveAttribute("aria-busy");
    expect(surface()).toHaveAttribute("contenteditable", "true");
    expect(errors.mock.calls.filter((call) => /lifecycle|flushSync/.test(String(call[0])))).toEqual([]);
    errors.mockRestore();
  });
});

describe("callouts and accordions (R-BLK-1, R-BLK-2, R-FMT-5)", () => {
  const TITLED = "<Callout title=\"Exact\">\nText with **bold**.\n</Callout>";

  it("edits the body visually and writes only the edited body", async () => {
    const { editor, onChange } = renderEditor(TITLED);
    const callout = await screen.findByRole("group", { name: "Exact" });
    expect(callout.querySelector("strong")).toHaveTextContent("bold");
    await settle(100);
    expect(onChange).not.toHaveBeenCalled();
    insertAt(editor, nodePos(editor, "Text with "), "Edited ");
    await waitFor(() => expect(lastChange(onChange)).toBe("<Callout title=\"Exact\">\nEdited Text with **bold**.\n</Callout>"));
  });

  it("edits the title in its properties and writes a quoted string as a JSX expression", async () => {
    const { onChange } = renderEditor(TITLED);
    fireEvent.click(await screen.findByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: "Title" });
    expect(input).toHaveValue("Exact");
    fireEvent.change(input, { target: { value: "Changed & quoted \"title\"" } });
    await waitFor(() => expect(lastChange(onChange)).toContain("title={\"Changed & quoted \\\"title\\\"\"}"));
  });

  it("keeps the caret while a property is typed, and returns to the body when properties close", async () => {
    const { editor } = renderEditor("<Callout title=\"Initial\">\nBody\n</Callout>");
    fireEvent.click(await screen.findByRole("button", { name: "Callout properties" }));
    const field = await screen.findByRole("textbox", { name: "Title" }) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "InXitial");
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await act(async () => {});
    expect(field).toHaveValue("InXitial");
    expect(field.selectionStart).toBe(3);
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument());
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.$from.parent.textContent).toBe("Body");
  });

  it.each([["before compositionend", true], ["after compositionend (WebKit)", false]])(
    "keeps the properties open when Enter commits IME text %s",
    async (_label, whileComposing) => {
      renderEditor("<Callout title=\"Initial\">\nBody\n</Callout>");
      fireEvent.click(await screen.findByRole("button", { name: "Callout properties" }));
      const input = await screen.findByRole("textbox", { name: "Title" });
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "中文标题" } });
      if (!whileComposing) fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: whileComposing ? 229 : 13, isComposing: whileComposing });
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("中文标题");
    },
  );

  it.each([["before compositionend", true], ["after compositionend", false]])(
    "keeps a Callout intact when Chinese IME text is committed by an Enter %s",
    async (_label, whileComposing) => {
      const { editor, onChange } = renderEditor("<Callout type=\"note\" collapsible={false} defaultOpen>\n\n</Callout>");
      await screen.findByRole("group", { name: "Note" });
      setCaret(editor, typePos(editor, "paragraph") + 1);
      fireEvent.compositionStart(surface());
      insertAt(editor, editor.state.selection.from, "中文");
      if (whileComposing) fireEvent.keyDown(surface(), { key: "Enter", code: "Enter", isComposing: true });
      fireEvent.compositionEnd(surface());
      if (!whileComposing) fireEvent.keyDown(surface(), { key: "Enter", code: "Enter", keyCode: 13 });
      await waitFor(() => expect(lastChange(onChange)).toContain("中文"));
      expect(editor.state.doc.firstChild?.type.name).toBe("latticeComponent");
      expect(editor.state.doc.firstChild?.childCount).toBe(1);
      expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    },
  );

  it("keeps an empty trailing paragraph inside on Enter, and repairs an emptied Callout", async () => {
    const { editor } = renderEditor("<Callout type=\"note\">\nBody\n</Callout>");
    await screen.findByRole("group", { name: "Note" });
    act(() => {
      editor.view.dispatch(editor.state.tr.delete(1, editor.state.doc.firstChild!.nodeSize - 1));
    });
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("paragraph");
    setCaret(editor, 2);
    expect(editor.commands.keyboardShortcut("Enter")).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
  });

  it("deletes the component where it is now, not what sits at its rendered position (R-PUB-22)", async () => {
    const text = "<Callout title=\"Target\">\nBody.\n</Callout>\n\nTail stays.\n";
    const { editor, onChange } = renderEditor(text);
    const button = await screen.findByRole("button", { name: "Delete Callout" });
    act(() => {
      editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.paragraph!.create(null, editor.schema.text("Inserted"))));
    });
    fireEvent.click(button);
    await waitFor(() => expect(lastChange(onChange)).toBe("Inserted\n\nTail stays.\n"));
  });

  it("refuses a chrome action once its component changed underneath it", async () => {
    const { editor } = renderEditor("<Callout title=\"Target\">\nBody.\n</Callout>\n");
    const button = await screen.findByRole("button", { name: "Delete Callout" });
    const refused = engineHealth.refusedChromeActions;
    // A concurrent write changes the node; the stale view is the one clicked before it re-renders.
    const stale = editor.state.doc.firstChild!;
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("Changed ", 2));
    });
    const { onLiveNode } = await import("./views/view-chrome");
    expect(onLiveNode(editor, () => 0, stale, (_position, transaction) => transaction)).toBe(false);
    expect(engineHealth.refusedChromeActions).toBe(refused + 1);
    expect(button).toBeInTheDocument();
  });

  it("migrates a legacy callout fence to MDX only once it is edited (R-FMT-6)", async () => {
    const { onChange } = renderEditor("```rw-component callout\n{\"title\":\"Legacy\",\"content\":\"Kept\"}\n```");
    fireEvent.click(await screen.findByRole("button", { name: "Callout properties" }));
    const input = await screen.findByRole("textbox", { name: "Title" });
    expect(input).toHaveValue("Legacy");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Migrated" } });
    await waitFor(() => {
      const next = lastChange(onChange);
      expect(next).toMatch(/^<Callout /);
      expect(next).toContain("title=\"Migrated\"");
      expect(next).toContain("Kept");
      expect(next).not.toContain("rw-component");
    });
  });

  it("opens an accordion by default when authored so, and keeps its content across a remount", async () => {
    const text = "<Accordion title=\"Details\" defaultOpen>\nA paragraph with **formatted text**.\n\n- First item\n- Second item\n\n```ts\nconst scale = Math.sqrt(64);\n```\n</Accordion>";
    const view = renderEditor(text);
    const expanded = async () => {
      const accordion = await screen.findByRole("group", { name: "Details" });
      expect(within(accordion).getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "true");
      expect(accordion).toHaveTextContent("A paragraph with formatted text");
      expect(accordion.querySelectorAll("li")).toHaveLength(2);
      expect(accordion).toHaveTextContent("const scale = Math.sqrt(64);");
    };
    await expanded();
    view.unmount();
    renderEditor(text);
    await expanded();
  });

  it("toggles a closed accordion open", async () => {
    renderEditor("<Accordion title=\"More\">\nHidden until opened.\n</Accordion>");
    const toggle = await screen.findByRole("button", { name: "More" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("source kept verbatim (R-BLK-16, R-RT-17)", () => {
  it("shows an unknown component as its source, edits it in place, and adopts remote changes silently", async () => {
    const { editor, onChange, rerender } = renderEditor("Before\n\n<Unknown>\n\nExact source\n\n</Unknown>");
    const group = await screen.findByRole("group", { name: "Unknown component: Unknown" });
    expect(group.querySelector("pre")?.textContent).toBe("<Unknown>\n\nExact source\n\n</Unknown>");
    rerender({ text: "Before\n\n<Unknown>\n\nRemote\n\n</Unknown>" });
    await waitFor(() => expect(screen.getByRole("group", { name: "Unknown component: Unknown" })).toHaveTextContent("Remote"));
    await settle(100);
    expect(onChange).not.toHaveBeenCalled();
    const start = nodePos(editor, (node) => node.type.name === "latticeRawBlock") + 1;
    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("<Unknown>\n\nUpdated source\n\n</Unknown>", start, start + editor.state.doc.child(1).content.size));
    });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\n<Unknown>\n\nUpdated source\n\n</Unknown>"));
  });

  it("keeps converter anchors as invisible scroll targets", async () => {
    renderEditor("<a id=\"S3.F1\"></a>\n\nSee Figure [1](#S3.F1).\n");
    await waitFor(() => expect(document.getElementById("S3.F1")).toHaveAttribute("aria-hidden", "true"));
  });
});

describe("code blocks (R-BLK-7, R-FMT-8)", () => {
  it("adds lines on every Enter without leaving the block", async () => {
    const { editor, onChange } = renderEditor("```js\nconst value = 1\n```");
    await screen.findByRole("button", { name: "Code block language: JavaScript. Click to change." });
    setCaret(editor, editor.state.doc.firstChild!.nodeSize - 1);
    for (let index = 0; index < 4; index += 1) fireEvent.keyDown(surface(), { key: "Enter", code: "Enter" });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe("const value = 1\n\n\n\n");
    expect(editor.state.selection.$from.parent.type.name).toBe("codeBlock");
    await waitFor(() => expect(lastChange(onChange)).toBe("```js\nconst value = 1\n\n\n\n\n```"));
  });

  it("highlights without putting a line ending inside a span", async () => {
    renderEditor("```js\n// first line\n// second line\n```");
    await waitFor(() => expect(document.querySelector(".hljs-comment")).not.toBeNull());
    const spans = [...document.querySelectorAll(".lx-md-code-pre span")];
    expect(spans.length).toBeGreaterThan(1);
    for (const span of spans) expect(span.textContent).not.toContain("\n");
  });

  it("changes the language token, commits the title on Enter, copies, and deletes", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { onChange } = renderEditor("```ts title=\"Example with spaces\"\nconst answer = 42;\n```");
    fireEvent.click(await screen.findByRole("button", { name: "Code block language: TypeScript. Click to change." }));
    fireEvent.click(await screen.findByRole("option", { name: "Python" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("```python title=\"Example with spaces\"\nconst answer = 42;\n```"));
    fireEvent.click(screen.getByRole("button", { name: "Code block settings" }));
    const title = await screen.findByRole("textbox", { name: "Code block title" });
    for (const value of ["U", "Up", "Updated", "Updated title"]) fireEvent.change(title, { target: { value } });
    await settle(50);
    expect(lastChange(onChange)).not.toContain("Updated title");
    fireEvent.keyDown(title, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(lastChange(onChange)).toBe("```python title=\"Updated title\"\nconst answer = 42;\n```"));
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const answer = 42;"));
    fireEvent.click(screen.getByRole("button", { name: "Delete code block" }));
    await waitFor(() => expect(lastChange(onChange)).toBe(""));
  });

  it("filters the language list and picks Mermaid, which then previews (R-BLK-5)", async () => {
    const { onChange } = renderEditor("```text\ngraph TD; A-->B\n```");
    fireEvent.click(await screen.findByRole("button", { name: "Code block language: Plain text. Click to change." }));
    fireEvent.change(await screen.findByPlaceholderText("Filter languages"), { target: { value: "Merm" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Filter languages"), { key: "Enter" });
    expect(await screen.findByRole("group", { name: "Mermaid preview" })).toBeInTheDocument();
    await waitFor(() => expect(lastChange(onChange)).toBe("```mermaid\ngraph TD; A-->B\n```"));
  });

  it("shows a Mermaid diagram with the code hidden until asked for", async () => {
    renderEditor("```mermaid title=\"Flow\" w=320px\ngraph TD; A-->B\n```");
    const preview = await screen.findByRole("group", { name: "Mermaid preview" });
    const block = preview.closest<HTMLElement>(".lx-md-code")!;
    expect(block).toHaveAttribute("data-code-visible", "false");
    expect(block).toHaveTextContent("graph TD; A-->B");
    const surfaceElement = preview.closest<HTMLElement>(".lx-md-code-preview")!;
    expect(surfaceElement).toHaveStyle({ width: "320px" });
    expect(within(surfaceElement).getByText("Flow")).toBeInTheDocument();
    expect(await within(preview).findByRole("button", { name: "Pan up" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide Mermaid preview" }));
    expect(screen.queryByRole("group", { name: "Mermaid preview" })).not.toBeInTheDocument();
    expect(block).toHaveAttribute("data-code-visible", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show Mermaid preview" }));
    expect(await screen.findByRole("group", { name: "Mermaid preview" })).toBeInTheDocument();
  });

  it("keeps odd Mermaid fences as plain code", async () => {
    renderEditor("~~~~MerMaid\ngraph TD; A-->B\n~~~~~\n\n````mermaid\ngraph TD; A-->B\n`````");
    await screen.findAllByRole("button", { name: /^Code block language/ });
    await settle(50);
    expect(screen.queryByRole("group", { name: "Mermaid preview" })).not.toBeInTheDocument();
  });
});

describe("formulas (R-INL-2, R-BLK-4, R-FMT-12)", () => {
  it("renders inline math as a selectable atom and opens its field only when the atom is selected", async () => {
    const { editor } = renderEditor("Before $x^2$ after.");
    await waitFor(() => expect(surface().querySelector(".lx-md-math .katex")).not.toBeNull());
    expect(surface()).toHaveAttribute("contenteditable", "true");
    selectNode(editor, 0);
    expect(screen.queryByText("Inline Math Properties")).not.toBeInTheDocument();
    selectNode(editor, typePos(editor, "latticeMath"));
    expect(await screen.findByText("Inline Math Properties")).toBeInTheDocument();
    expect(surface().querySelector(".lx-md-math")).toHaveClass("is-selected");
  });

  it.each([["dollars", "The result is $x^2$."], ["LaTeX delimiters", "The result is \\(x^2\\)."]])(
    "edits a formula written with %s and writes it with dollars",
    async (_label, text) => {
      const { editor, onChange } = renderEditor(text);
      await waitFor(() => expect(typePos(editor, "latticeMath")).toBeGreaterThan(0));
      selectNode(editor, typePos(editor, "latticeMath"));
      const input = await screen.findByRole("textbox", { name: "Formula" });
      for (const value of ["y", "y^", "y^3"]) fireEvent.change(input, { target: { value } });
      await waitFor(() => expect(surface().querySelector(".lx-md-math")).toHaveAttribute("data-formula", "y^3"));
      await settle(50);
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("The result is $y^3$.", text));
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Formula" })).not.toBeInTheDocument());
    },
  );

  it("collapses a typed $formula$ into an atom, and keeps prices as prose", async () => {
    const { editor, onChange } = renderEditor("Start here:");
    act(() => {
      editor.commands.focus("end");
      typeText(editor, " $x+y$");
    });
    expect(editor.state.doc.nodeAt(typePos(editor, "latticeMath"))?.attrs.tex).toBe("x+y");
    await waitFor(() => expect(lastChange(onChange)).toBe("Start here: $x+y$"));
    cleanup();
    renderEditor("It costs $5 and then $10 more.");
    await settle(50);
    expect(surface()).toHaveTextContent("It costs $5 and then $10 more.");
    expect(surface().querySelector(".lx-md-math")).toBeNull();
  });

  it("renders LaTeX 2.09 font switches upright and slanted", async () => {
    renderEditor("Inline $\\sc t$ and ${\\sl slanted}$.\n\n$$\n{\\sc Display}\n$$");
    await waitFor(() => expect(surface().querySelectorAll(".katex")).toHaveLength(3));
    expect(surface().querySelector(".lx-md-math .mathrm")).toHaveTextContent("t");
    expect(surface().querySelectorAll(".lx-md-math")[1]?.querySelector(".mathit")).toHaveTextContent("slanted");
    expect(surface().querySelector(".lx-md-math-block .mathrm")).toHaveTextContent("Display");
    expect(document.querySelector("[style*=\"color:#cc0000\"]")).toBeNull();
  });

  it("offers only properties and delete for a selected display formula, and edits it", async () => {
    const { editor, onChange } = renderEditor("Before\n\n$$\nx\n$$\n\nAfter");
    await waitFor(() => expect(typePos(editor, "latticeMathBlock")).toBeGreaterThan(0));
    selectNode(editor, typePos(editor, "latticeMathBlock"));
    const block = surface().querySelector<HTMLElement>(".lx-md-math-block")!;
    const buttons = await within(block).findAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Equation properties", "Delete equation"]);
    fireEvent.click(buttons[0]!);
    const field = await screen.findByRole("textbox", { name: "Formula" });
    fireEvent.change(field, { target: { value: "x^2" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\n$$\nx^2\n$$\n\nAfter"));
  });

  it("copies a display formula between editors with its formula", async () => {
    render(
      <>
        <LatticeVisualMarkdownEditor text={"$$\nE=mc^2\n$$"} activePath="source.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />
        <LatticeVisualMarkdownEditor text="Destination" activePath="destination.md" onChangeMarkdown={() => true} onUndo={() => true} onRedo={() => true} />
      </>,
    );
    const [source, destination] = screen.getAllByRole("textbox", { name: "Markdown document editor" }) as (HTMLElement & { editor: Editor })[];
    act(() => {
      source!.editor.view.dispatch(source!.editor.state.tr.setNodeMarkup(0, undefined, { ...source!.editor.state.doc.firstChild!.attrs, tex: "E=mc^3" }));
    });
    selectNode(source!.editor, 0);
    const data = new Map<string, string>();
    const clipboardData = {
      clearData: () => data.clear(),
      getData: (type: string) => data.get(type) ?? "",
      setData: (type: string, value: string) => { data.set(type, value); },
    } as unknown as DataTransfer;
    fireEvent.copy(source!, { clipboardData });
    act(() => destination!.editor.commands.selectAll());
    fireEvent.paste(destination!, { clipboardData });
    expect(destination!.editor.state.doc.firstChild?.type.name).toBe("latticeMathBlock");
    expect(destination!.editor.state.doc.firstChild?.attrs.tex).toBe("E=mc^3");
  });
});

describe("images (R-BLK-3, R-FMT-7)", () => {
  it.each([
    ["a Markdown image", "![Plot](../figures/plot.png)", "figures/plot.png", "Plot"],
    ["an HTML image", "<img src=\"../figures/block.png\" alt=\"Block\" />", "figures/block.png", "Block"],
  ])("loads %s through the host asset reader", async (_label, text, path, name) => {
    const onLoadAsset = vi.fn(async () => PNG);
    renderEditor({ text, activePath: "notes/results.md", onLoadAsset });
    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith(path));
    const image = await screen.findByRole("img", { name });
    await waitFor(() => expect(image).toHaveAttribute("src", PNG));
    expect(image).toHaveAttribute("decoding", "async");
  });

  it("aligns from the hover toolbar and writes the alignment", async () => {
    const { onChange } = renderEditor({ text: "![Plot](figures/plot.png)", onLoadAsset: async () => PNG });
    await screen.findByRole("img", { name: "Plot" });
    expect(surface().querySelector(".lx-md-image")).toHaveAttribute("data-image-size", "auto");
    expect(screen.getByRole("button", { name: "Align center" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Align right" }));
    await waitFor(() => expect(lastChange(onChange)).toBe("<img src=\"figures/plot.png\" alt=\"Plot\" align=\"right\" />"));
  });

  it("resizes from an edge and writes an integer width without a height", async () => {
    const { onChange } = renderEditor({ text: "![Plot](figures/plot.png \"Results\")", onLoadAsset: async () => PNG });
    await screen.findByRole("img", { name: "Plot" });
    const frame = surface().querySelector<HTMLElement>(".lx-md-image-frame")!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 240));
    const handle = frame.querySelector<HTMLElement>(".lx-md-resize-handle[data-side=\"right\"]")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 320, clientY: 120 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 360, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 360, clientY: 120 });
    await waitFor(() => expect(lastChange(onChange)).toBe("<img src=\"figures/plot.png\" alt=\"Plot\" title=\"Results\" width={400} />"));
    await waitFor(() => expect(surface().querySelector(".lx-md-image")).toHaveAttribute("data-image-size", "authored"));
  });

  it("never gives an unsafe scheme to the DOM", async () => {
    renderEditor("<img src=\"javascript:alert(1)\" alt=\"Bad\" />\n\n![File](file:///etc/passwd)");
    await screen.findByRole("img", { name: "Bad" });
    for (const element of document.querySelectorAll("[src], [href]")) {
      expect(element.getAttribute("src") ?? element.getAttribute("href")).not.toMatch(/^(?:javascript|file):/);
    }
  });

  it("rests after an image when its properties close, adding no paragraph", async () => {
    const { editor } = renderEditor({ text: "![Plot](figures/plot.png)", onLoadAsset: async () => PNG });
    await screen.findByRole("img", { name: "Plot" });
    fireEvent.click(screen.getByRole("button", { name: "Image properties" }));
    fireEvent.keyDown(await screen.findByRole("textbox", { name: "Image source" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Image source" })).not.toBeInTheDocument());
    expect(editor.state.selection.from).toBe(editor.state.doc.firstChild!.nodeSize - 1);
    expect(editor.state.doc.childCount).toBe(1);
  });

  it("lays out converter paper figures in their columns with their anchors (R-BLK-15)", async () => {
    const text = [
      "<PaperFigure id=\"S2.F1\">", "", "<PaperFigureRow columns=\"3 3 3\">", "",
      "<PaperFigurePanel id=\"S2.F1.placeholder\">", "</PaperFigurePanel>", "",
      "<PaperFigurePanel id=\"S2.F1.sf1\">", "", "![First panel](paper_assets/first.webp)", "", "*(a) Swiss Roll*", "", "</PaperFigurePanel>", "",
      "</PaperFigureRow>", "", "*Figure 1: Manifold examples.*", "", "</PaperFigure>",
    ].join("\n");
    renderEditor({ text, activePath: ".research/papers/2311.03757/paper.md", onLoadAsset: async () => PNG });
    await screen.findByRole("img", { name: "First panel" });
    expect(document.getElementById("S2.F1")?.tagName).toBe("FIGURE");
    expect(document.querySelector<HTMLElement>(".lx-md-paper-figure-row")?.style.getPropertyValue("--lx-md-figure-columns"))
      .toBe("minmax(0, 3fr) minmax(0, 3fr) minmax(0, 3fr)");
    expect(document.getElementById("S2.F1.placeholder")).toBeInTheDocument();
    expect(document.getElementById("S2.F1.sf1")).toHaveTextContent("(a) Swiss Roll");
  });
});

describe("footnotes (R-BLK-6)", () => {
  it("shows the reference by label and the definition as an editable, numbered note", async () => {
    const { editor, onChange } = renderEditor("Evidence[^source].\n\n[^source]: Supporting **result**.\n\n    Second **paragraph**.");
    expect(await screen.findByRole("link", { name: "[source]" })).toHaveAttribute("href", "#fn-source");
    const note = await screen.findByRole("complementary", { name: "Footnote source" });
    expect([...note.querySelectorAll("strong")].map((strong) => strong.textContent)).toEqual(["result", "paragraph"]);
    expect(within(note).getByRole("link", { name: "Back to reference" })).toHaveAttribute("href", "#fnref-source");
    insertAt(editor, nodePos(editor, "Supporting "), "Extra ");
    await waitFor(() => expect(lastChange(onChange)).toContain("[^source]: Extra Supporting **result**.\n\n    Second **paragraph**."));
  });
});

describe("tables (R-BLK-11, R-FMT-10, R-FMT-22)", () => {
  const SIMPLE = "| Left | Right |\n| --- | --- |\n| A | B |";

  it("moves down a column on Enter and appends a row at the bottom, keeping the header", async () => {
    const { editor, onChange } = renderEditor(SIMPLE);
    setCaret(editor, nodePos(editor, "A") + 1);
    fireEvent.keyDown(surface(), { key: "Enter" });
    await waitFor(() => expect(surface().querySelectorAll("tr")).toHaveLength(3));
    expect(surface().querySelectorAll("tr:first-child th")).toHaveLength(2);
    await waitFor(() => expect(lastChange(onChange)).toMatch(/\| Left\s+\| Right\s+\|\n\| -+ \| -+ \|/));
  });

  it("inserts a row below from the row menu", async () => {
    const { editor, onChange } = renderEditor(SIMPLE);
    setCaret(editor, nodePos(editor, "A") + 1);
    const rowOptions = await screen.findByRole("button", { name: "Row options" });
    fireEvent.pointerDown(rowOptions, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Insert row below" }));
    await waitFor(() => expect(surface().querySelectorAll("tr")).toHaveLength(3));
    await waitFor(() => expect(lastChange(onChange)).toMatch(/\| Left\s+\| Right\s+\|\n\| -+ \| -+ \|\n\| A +\| B +\|\n\| +\| +\|/));
  });

  it("merges selected cells into one, showing equal values once and keeping alignment", async () => {
    const { editor, onChange } = renderEditor("| Group | Group | Metric |\n| :--- | ---: | :---: |\n| A | B | 1 |");
    const cells: number[] = [];
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "tableHeader") cells.push(position);
    });
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cells[0]!, cells[1]!)));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Merge cells" }));
    const headers = surface().querySelectorAll("th");
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent(/^Group$/);
    expect(headers[0]).toHaveAttribute("colspan", "2");
    await waitFor(() => expect(lastChange(onChange)).toContain("<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2]]} -->"));
    expect(lastChange(onChange)).toContain("| Group | Group | Metric |");
    expect(lastChange(onChange)).toMatch(/\| :-+ \| -+: \| :-+: \|/);
  });

  it("splits one merged cell and keeps the other span", async () => {
    const { editor, onChange } = renderEditor([
      "<!-- lattice-table-layout:v1 {\"spans\":[[0,0,1,2],[0,2,1,2]]} -->", "",
      "| Left | Left | Right | Right |", "| --- | --- | --- | --- |", "| A | B | C | D |",
    ].join("\n"));
    setCaret(editor, nodePos(editor, "Left") + 1);
    fireEvent.click(await screen.findByRole("button", { name: "Split cell" }));
    const headers = surface().querySelectorAll("th");
    expect(headers).toHaveLength(3);
    expect(headers[0]).toHaveTextContent("Left");
    expect(headers[1]).toHaveTextContent("Left");
    expect(headers[2]).toHaveAttribute("colspan", "2");
    await waitFor(() => expect(lastChange(onChange)).toContain("<!-- lattice-table-layout:v1 {\"spans\":[[0,2,1,2]]} -->"));
  });

  it("splits an inferred paper cell and writes the explicit unmerged layout", async () => {
    const text = "| Group | Group | Metric |\n| --- | --- | --- |\n| Group | Group | 1 |\n| Other | Variant | 2 |";
    const { editor, onChange } = renderEditor({ text, activePath: ".research/papers/example/paper.md", optimizeForReading: true });
    expect(surface().querySelector("th")).toHaveAttribute("colspan", "2");
    setCaret(editor, nodePos(editor, "Group") + 1);
    fireEvent.click(await screen.findByRole("button", { name: "Split cell" }));
    await waitFor(() => expect(lastChange(onChange)).toBe(`<!-- lattice-table-layout:v1 {"spans":[]} -->\n\n${text}`));
  });

  it("deletes a block-selected table as a unit", async () => {
    const { editor, onChange } = renderEditor(`Before\n\n${SIMPLE}\n\nAfter`);
    selectNode(editor, typePos(editor, "table"));
    expect(editor.commands.keyboardShortcut("Delete")).toBe(true);
    await waitFor(() => expect(lastChange(onChange)).toBe("Before\n\nAfter"));
  });
});
