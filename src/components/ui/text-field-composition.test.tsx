import type { ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Input } from "./input";
import { SearchField } from "./search-field";
import { Textarea } from "./textarea";

type Field = ComponentType<{
  "aria-label": string;
  onKeyDown: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}>;

const fields: Array<[string, Field]> = [["Input", Input], ["Textarea", Textarea], ["SearchField", SearchField]];

describe.each(fields)("%s under an input method", (_, Field) => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("hands onKeyDown only the keys meant for the field, and still reports the composition", () => {
    vi.useFakeTimers();
    const onKeyDown = vi.fn();
    const onCompositionStart = vi.fn();
    const onCompositionEnd = vi.fn();
    render(<Field aria-label="field" onKeyDown={onKeyDown} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />);
    const field = screen.getByLabelText("field");

    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "ArrowDown", keyCode: 229, isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.keyDown(field, { key: "Escape", keyCode: 229, isComposing: true });
    // Some input methods report their keys as "Process" without isComposing.
    fireEvent.keyDown(field, { key: "Process" });
    fireEvent.compositionEnd(field);
    // WebKit sends compositionend just before the Enter that accepted the candidate.
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onCompositionStart).toHaveBeenCalledTimes(1);
    expect(onCompositionEnd).toHaveBeenCalledTimes(1);

    act(() => vi.runAllTimers());
    fireEvent.keyDown(field, { key: "Enter", keyCode: 13 });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
