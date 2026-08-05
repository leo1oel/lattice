import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatexSelectionToolbar } from "./latex-selection-toolbar";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const position = { left: 200, top: 100, below: false, maxWidth: 400 };

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("LaTeX selection toolbar", () => {
  it("exposes formatting actions and the comment action for the primary editor", () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onAction).toHaveBeenNthCalledWith(1, "bold");
    expect(onAction).toHaveBeenNthCalledWith(2, "comment");
    expect(screen.getByRole("button", { name: "Heading level" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Highlight color" })).toBeInTheDocument();
  });

  it("offers heading levels", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
    fireEvent.click(await screen.findByRole("button", { name: /Subsection/ }));
    expect(onAction).toHaveBeenCalledWith("heading", "subsection");
  });

  it("offers arbitrary highlight colors", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Highlight color" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select #FFCC00" }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply highlight color" }));
    expect(onAction).toHaveBeenCalledWith("highlight", "#FFCC00");
  });

  it("discards a drafted highlight color when cancelled", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Highlight color" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select #FFCC00" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel color selection" }));

    expect(onAction).not.toHaveBeenCalled();
  });

  it("opens the system-wide color sampler instead of the HTML color panel", async () => {
    vi.mocked(invoke).mockResolvedValue("#AABBCC");
    const nativePicker = vi.spyOn(HTMLInputElement.prototype, "click");
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Highlight color" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick color from screen" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sample_screen_color"));
    fireEvent.click(screen.getByRole("button", { name: "Apply highlight color" }));
    expect(onAction).toHaveBeenCalledWith("highlight", "#AABBCC");
    expect(nativePicker).not.toHaveBeenCalled();
    nativePicker.mockRestore();
  });

  it("collects a URL before applying a link", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = await screen.findByLabelText("Link URL");
    fireEvent.change(input, { target: { value: "https://example.com/paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("link", "https://example.com/paper"));
  });

  it("omits comments where the secondary editor cannot attach them", () => {
    render(<LatexSelectionToolbar position={{ ...position, below: true }} canComment={false} onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar")).toHaveClass("below");
  });

  it("offers only comments for Markdown selections", () => {
    render(<LatexSelectionToolbar position={position} canComment commentOnly onAction={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole("toolbar", { name: "Comment on selected Markdown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("keeps pointer focus in CodeMirror while a tool is pressed", () => {
    render(<LatexSelectionToolbar position={position} canComment onAction={vi.fn()} onDismiss={vi.fn()} />);
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });

    screen.getByRole("toolbar").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("dismisses when another part of the app is pressed", () => {
    const onDismiss = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={vi.fn()} onDismiss={onDismiss} />);

    fireEvent.pointerDown(document.body);

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
