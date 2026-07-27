import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "Section heading" })).toBeInTheDocument();
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
