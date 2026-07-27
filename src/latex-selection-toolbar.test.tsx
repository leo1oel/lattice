import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatexSelectionToolbar } from "./latex-selection-toolbar";

const position = { left: 200, top: 100, below: false, maxWidth: 400 };

afterEach(cleanup);

describe("LaTeX selection toolbar", () => {
  it("exposes formatting actions and the comment action for the primary editor", () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onAction).toHaveBeenNthCalledWith(1, "bold");
    expect(onAction).toHaveBeenNthCalledWith(2, "comment");
    expect(screen.getByRole("button", { name: "Heading level" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Highlight color" })).toBeInTheDocument();
  });

  it("offers heading levels", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Heading level" }));
    fireEvent.click(await screen.findByRole("button", { name: /Subsection/ }));
    expect(onAction).toHaveBeenCalledWith("heading", "subsection");
  });

  it("offers highlight colors", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Highlight color" }));
    fireEvent.click(await screen.findByRole("button", { name: "Highlight pink" }));
    expect(onAction).toHaveBeenCalledWith("highlight", "pink");
  });

  it("collects a URL before applying a link", async () => {
    const onAction = vi.fn();
    render(<LatexSelectionToolbar position={position} canComment onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = await screen.findByLabelText("Link URL");
    fireEvent.change(input, { target: { value: "https://example.com/paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith("link", "https://example.com/paper"));
  });

  it("omits comments where the secondary editor cannot attach them", () => {
    render(<LatexSelectionToolbar position={{ ...position, below: true }} canComment={false} onAction={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar")).toHaveClass("below");
  });

  it("keeps pointer focus in CodeMirror while a tool is pressed", () => {
    render(<LatexSelectionToolbar position={position} canComment onAction={vi.fn()} />);
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });

    screen.getByRole("toolbar").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
