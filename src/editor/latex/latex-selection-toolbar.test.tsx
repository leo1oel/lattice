import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const openPicker = async () => {
  fireEvent.click(button("Highlight color"));
  fireEvent.click(await screen.findByRole("button", { name: "Select #FFCC00" }));
};

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("LaTeX selection toolbar", () => {
  it("exposes formatting actions and the comment action for the primary editor", () => {
    const { onAction } = renderToolbar();
    fireEvent.click(button("Bold"));
    fireEvent.click(button("Comment"));
    expect(onAction).toHaveBeenNthCalledWith(1, "bold");
    expect(onAction).toHaveBeenNthCalledWith(2, "comment");
    expect(button("Comment").closest(".latex-selection-tool")).toHaveClass("separated");
    expect(button("Heading level")).toBeInTheDocument();
    expect(button("Highlight color")).toBeInTheDocument();
  });

  it("offers heading levels", async () => {
    const { onAction } = renderToolbar();
    fireEvent.click(button("Heading level"));
    fireEvent.click(await screen.findByRole("button", { name: /Subsection/ }));
    expect(onAction).toHaveBeenCalledWith("heading", "subsection");
  });

  it.each([
    ["applies a drafted highlight color", "Apply highlight color", [["highlight", "#FFCC00"]]],
    ["discards a drafted highlight color when cancelled", "Cancel color selection", []],
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
    fireEvent.click(button("Highlight color"));
    fireEvent.click(await screen.findByRole("button", { name: "Pick color from screen" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sample_screen_color"));
    fireEvent.click(button("Apply highlight color"));
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

  it("omits comments where the secondary editor cannot attach them", () => {
    renderToolbar({ position: { ...position, below: true }, canComment: false });
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar")).toHaveClass("below");
  });

  it("offers only comments for Markdown selections", () => {
    renderToolbar({ commentOnly: true });
    expect(screen.getByRole("toolbar", { name: "Comment on selected Markdown" })).toBeInTheDocument();
    expect(button("Comment")).toBeInTheDocument();
    expect(button("Comment").closest(".latex-selection-tool")).not.toHaveClass("separated");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps pointer focus in CodeMirror while a tool is pressed", () => {
    renderToolbar();
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    screen.getByRole("toolbar").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("dismisses when another part of the app is pressed", () => {
    const { onDismiss } = renderToolbar();
    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
