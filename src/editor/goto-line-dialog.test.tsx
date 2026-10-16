import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GotoLineDialog } from "./goto-line-dialog";
import { activateAppLocale } from "../i18n";

describe("GotoLineDialog", () => {
  beforeEach(() => activateAppLocale("en"));
  afterEach(cleanup);

  it("starts with the current line selected, so a typed number replaces it", () => {
    const onGoto = vi.fn();
    render(<GotoLineDialog open line={12} maxLine={400} onClose={vi.fn()} onGoto={onGoto} />);
    const input = screen.getByRole("textbox", { name: "Line number" }) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGoto).toHaveBeenCalledWith(150);
  });

  it("consumes the Enter that submits, so the editor it hands focus back to does not type it", () => {
    const onGoto = vi.fn();
    render(<GotoLineDialog open line={12} maxLine={400} onClose={vi.fn()} onGoto={onGoto} />);
    const input = screen.getByRole("textbox", { name: "Line number" });
    fireEvent.change(input, { target: { value: "9" } });
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(onGoto).toHaveBeenCalledWith(9);
  });

  it("leaves an Enter that commits an IME composition alone", () => {
    const onGoto = vi.fn();
    render(<GotoLineDialog open line={12} maxLine={400} onClose={vi.fn()} onGoto={onGoto} />);
    const input = screen.getByRole("textbox", { name: "Line number" });
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(onGoto).not.toHaveBeenCalled();
  });
});
