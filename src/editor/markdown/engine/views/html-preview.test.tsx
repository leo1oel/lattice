/**
 * Block HTML in the visual editor (R-BLK-16): drawn from the sanitized markup,
 * its source shown while the caret is in it, and the file left byte for byte.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisualMarkdownEditorProps } from "../../visual-editor-props";
import { LatticeVisualMarkdownEditor } from "../lattice-visual-editor";

type Props = VisualMarkdownEditorProps;

const FIGURE = `Fig. 1

<div>

<svg xmlns="http://www.w3.org/2000/svg" width="790" height="312" viewBox="0 0 790 312" onload="steal()">
  <rect x="20" y="40" width="180" height="80" fill="#eef4ff" stroke="#3b6fd8"/>
  <text x="110" y="85">Encoder</text>
  <script>steal()</script>
</svg>

</div>

After.
`;

const surface = () => screen.getByRole("textbox", { name: "Markdown document editor" }) as HTMLElement & { editor: Editor };
const shadow = () => document.querySelector<HTMLElement>("[data-lattice-html-preview]")?.shadowRoot ?? null;
const block = () => screen.getByRole("group", { name: "HTML" });

function renderEditor(text: string, props: Partial<Props> = {}) {
  const onChange = vi.fn<Props["onChangeMarkdown"]>(() => true);
  render(<LatticeVisualMarkdownEditor text={text} activePath="notes.md" onChangeMarkdown={onChange} onUndo={() => true} onRedo={() => true} {...props} />);
  return { onChange };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HTML block preview", () => {
  it("draws the SVG figure with its source hidden, and without its script", async () => {
    const { onChange } = renderEditor(FIGURE);
    await waitFor(() => expect(shadow()?.querySelector("svg rect")).not.toBeNull());
    const svg = shadow()!.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 790 312");
    expect(svg.hasAttribute("onload")).toBe(false);
    expect(shadow()!.querySelector("text")!.textContent).toBe("Encoder");
    expect(shadow()!.querySelector("script")).toBeNull();
    expect(block()).toHaveAttribute("data-preview", "true");
    expect(block().querySelector("pre.lx-md-raw-source")).toHaveAttribute("hidden");
    // The source stays the document's text, so nothing was rewritten.
    expect(block().querySelector("pre.lx-md-raw-source")!.textContent).toContain("<script>steal()</script>");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the source while the caret is in it and the drawing once it leaves", async () => {
    const { onChange } = renderEditor(FIGURE);
    await waitFor(() => expect(shadow()?.querySelector("svg")).not.toBeNull());
    fireEvent.mouseDown(document.querySelector(".lx-md-html-preview")!, { button: 0 });
    await waitFor(() => expect(block()).toHaveAttribute("data-preview", "false"));
    expect(block().querySelector("pre.lx-md-raw-source")).not.toHaveAttribute("hidden");
    const { editor } = surface();
    expect(editor.state.selection.$from.parent.type.name).toBe("latticeRawBlock");

    act(() => {
      editor.view.dispatch(editor.state.tr.insertText("<!-- edited -->\n", editor.state.selection.from));
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(String(onChange.mock.lastCall?.[0])).toBe(FIGURE.replace("\n<div>", "\n<!-- edited -->\n<div>"));

    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    });
    await waitFor(() => expect(block()).toHaveAttribute("data-preview", "true"));
    expect(shadow()?.querySelector("svg rect")).not.toBeNull();
  });

  it("switches with Edit HTML and Show preview", async () => {
    renderEditor(FIGURE);
    fireEvent.click(await screen.findByRole("button", { name: "Edit HTML" }));
    await waitFor(() => expect(block()).toHaveAttribute("data-preview", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    await waitFor(() => expect(block()).toHaveAttribute("data-preview", "true"));
  });

  it("toggles the source in a read-only view", async () => {
    renderEditor(FIGURE, { editable: false });
    await waitFor(() => expect(shadow()?.querySelector("svg")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Edit HTML" }));
    await waitFor(() => expect(block()).toHaveAttribute("data-preview", "false"));
  });

  it("says when the markup has nothing to show", async () => {
    renderEditor("<div><script>steal()</script></div>\n");
    await waitFor(() => expect(document.querySelector(".lx-md-html-preview")).toHaveAttribute("data-blank"));
    expect(document.querySelector(".lx-md-html-preview")).toHaveAttribute("data-empty-label", "Nothing to show");
  });
});
