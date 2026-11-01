import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatexSelectionToolbar } from "./latex-selection-toolbar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const position = { left: 200, top: 100, below: false, maxWidth: 400 };

function renderToolbar(props: Partial<Parameters<typeof LatexSelectionToolbar>[0]> = {}) {
  const handlers = { onAction: vi.fn(), onDismiss: vi.fn() };
  render(<LatexSelectionToolbar position={position} canComment {...handlers} {...props} />);
  return handlers;
}
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const openCustomPicker = async () => {
  fireEvent.click(button("Highlight color"));
  fireEvent.click(await screen.findByRole("button", { name: "Custom colour…" }));
};
const openPicker = async () => {
  await openCustomPicker();
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Paper tones" })).getByRole("radio", { name: /#FFE0C6$/ }));
};

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

describe("LaTeX selection toolbar", () => {
  it("exposes formatting, heading-level, and comment actions for the primary editor", async () => {
    const { onAction } = renderToolbar();
    fireEvent.click(button("Bold"));
    fireEvent.click(button("Annotate"));
    expect(onAction).toHaveBeenNthCalledWith(1, "bold");
    expect(onAction).toHaveBeenNthCalledWith(2, "comment");
    expect(button("Annotate").closest(".latex-selection-tool")).toHaveClass("separated");
    expect(button("Highlight color")).toBeInTheDocument();
    fireEvent.click(button("Heading level"));
    fireEvent.click(await screen.findByRole("button", { name: /Subsection/ }));
    expect(onAction).toHaveBeenCalledWith("heading", "subsection");
  });

  it.each([
    ["applies a drafted highlight color", "Highlight", [["highlight", "#FFE0C6"]]],
    ["discards a drafted highlight color when cancelled", "Cancel", []],
  ])("%s", async (_name, control, calls) => {
    const { onAction } = renderToolbar();
    await openPicker();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(button(control));
    expect(onAction.mock.calls).toEqual(calls);
  });

  it("opens the system-wide color sampler instead of the HTML color panel", async () => {
    vi.mocked(invoke).mockResolvedValue("#AABBCC");
    const nativePicker = vi.spyOn(HTMLInputElement.prototype, "click");
    const { onAction } = renderToolbar();
    await openCustomPicker();
    fireEvent.click(await screen.findByRole("button", { name: "Pick color from screen" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sample_screen_color"));
    fireEvent.click(button("Highlight"));
    expect(onAction).toHaveBeenCalledWith("highlight", "#AABBCC");
    expect(nativePicker).not.toHaveBeenCalled();
    nativePicker.mockRestore();
  });

  it("collects a URL before applying a link", async () => {
    const { onAction } = renderToolbar();
    fireEvent.click(button("Link"));
    const input = await screen.findByLabelText("Link URL");
    fireEvent.change(input, { target: { value: "https://example.com/paper" } });
    fireEvent.click(button("Apply link"));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("link", "https://example.com/paper"));
  });

  it("rewrites by a typed instruction and offers it again among the recent ones", async () => {
    const first = renderToolbar({ canProofread: true });
    fireEvent.click(button("Rewrite with an instruction"));
    // Before the writer has instructions of their own, it suggests some.
    expect(await screen.findByRole("group", { name: "Suggested instructions" })).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Instruction" });
    expect(field).toHaveFocus();
    expect(button("Rewrite")).toBeDisabled();
    fireEvent.change(field, { target: { value: "  Cut to   100 words " } });
    fireEvent.submit(field.closest("form")!);
    expect(first.onAction).toHaveBeenCalledWith("rewrite", "Cut to 100 words");
    cleanup();

    const second = renderToolbar({ canProofread: true });
    fireEvent.click(button("Rewrite with an instruction"));
    const recent = await screen.findByRole("group", { name: "Recent instructions" });
    fireEvent.click(within(recent).getByRole("button", { name: "Cut to 100 words" }));
    expect(second.onAction).toHaveBeenCalledWith("rewrite", "Cut to 100 words");
  });

  it("sends a suggested instruction as it reads", async () => {
    const { onAction } = renderToolbar({ canProofread: true });
    fireEvent.click(button("Rewrite with an instruction"));
    const suggested = await screen.findByRole("group", { name: "Suggested instructions" });
    fireEvent.click(within(suggested).getByRole("button", { name: "Translate into academic English" }));
    expect(onAction).toHaveBeenCalledWith("rewrite", "Translate into academic English");
  });

  it("offers rewriting only where proofreading is", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: "Rewrite with an instruction" })).not.toBeInTheDocument();
    cleanup();
    renderToolbar({ canProofread: true, commentOnly: true });
    expect(screen.queryByRole("button", { name: "Rewrite with an instruction" })).not.toBeInTheDocument();
    cleanup();
    renderToolbar({ canProofread: true });
    expect(button("Polish").closest(".latex-selection-tool")!.nextElementSibling).toContainElement(button("Rewrite with an instruction"));
  });

  it("omits comments where the secondary editor cannot attach them", () => {
    renderToolbar({ position: { ...position, below: true }, canComment: false });
    expect(screen.queryByRole("button", { name: "Annotate" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar")).toHaveClass("below");
  });

  it("offers only comments for Markdown selections", () => {
    renderToolbar({ commentOnly: true });
    expect(screen.getByRole("toolbar", { name: "Comment on selected Markdown" })).toBeInTheDocument();
    expect(button("Annotate")).toBeInTheDocument();
    expect(button("Annotate").closest(".latex-selection-tool")).not.toHaveClass("separated");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps pointer focus in CodeMirror while a tool is pressed, and dismisses when another part of the app is", () => {
    const { onDismiss } = renderToolbar();
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    screen.getByRole("toolbar").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
