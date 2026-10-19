import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownSelectionFormat } from "../editor/markdown/markdown-source-format";
import { MarkdownSourceToolbar } from "./markdown-source-toolbar";

const position = { left: 200, top: 100, below: false, maxWidth: 600 };
const plain: MarkdownSelectionFormat = { inline: new Set(), block: "text", inCode: false };

function renderToolbar(props: Partial<Parameters<typeof MarkdownSourceToolbar>[0]> = {}) {
  const handlers = { onAction: vi.fn(), onDismiss: vi.fn() };
  render(<MarkdownSourceToolbar position={position} format={plain} editable {...handlers} {...props} />);
  return handlers;
}
const buttonNames = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));

afterEach(cleanup);

describe("Markdown source toolbar", () => {
  it("offers the visual toolbar's formats with Markdown forms, and Annotate", () => {
    renderToolbar();
    expect(buttonNames()).toEqual([
      "Block type", "Bold", "Italic", "Underline", "Strikethrough", "Inline code", "Highlight",
      "Insert link", "Convert selection to inline math", "Annotate",
    ]);
  });

  it("asks for inline formats, block types and comments", async () => {
    const { onAction } = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert link" }));
    fireEvent.click(screen.getByRole("button", { name: "Annotate" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Block type" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Heading 2" }));
    expect(onAction.mock.calls).toEqual([[{ format: "bold" }], [{ format: "link" }], ["comment"], [{ block: "heading-2" }]]);
  });

  it("presses the formats the selection has and names its block type", () => {
    renderToolbar({ format: { inline: new Set(["bold", "link"]), block: "quote", inCode: false } });
    expect(screen.getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Insert link" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Block type" }).textContent).toBe("Quote");
  });

  it("keeps only the block type menu and Annotate inside a code block", () => {
    renderToolbar({ format: { inline: new Set(), block: "code-block", inCode: true } });
    expect(buttonNames()).toEqual(["Block type", "Annotate"]);
  });

  it("offers only Annotate on a read-only file", () => {
    renderToolbar({ editable: false });
    expect(buttonNames()).toEqual(["Annotate"]);
  });

  it("dismisses on a press outside its surfaces", () => {
    const { onDismiss } = renderToolbar();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Bold" }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
