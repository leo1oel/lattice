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
});
