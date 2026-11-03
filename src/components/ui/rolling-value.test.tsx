import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RollingValue } from "./rolling-value";

afterEach(cleanup);

const count = (value: number, of?: string) => <RollingValue value={value} of={of}>{`${value}×`}</RollingValue>;

describe("RollingValue", () => {
  it("rolls only when the same thing's count changes, up as it rises and down as it falls", () => {
    const { container, rerender } = render(count(1, "dao"));
    const shown = () => container.querySelector(".ui-rolling-value");
    expect(shown()).toHaveTextContent("1×");
    expect(shown()).not.toHaveAttribute("data-roll");

    rerender(count(2, "dao"));
    expect(shown()).toHaveTextContent("2×");
    expect(shown()).toHaveAttribute("data-roll", "up");

    rerender(count(1, "dao"));
    expect(shown()).toHaveAttribute("data-roll", "down");

    // A recycled row showing another paper's count does not roll.
    rerender(count(5, "gu"));
    expect(shown()).toHaveTextContent("5×");
    expect(shown()).not.toHaveAttribute("data-roll");
  });
});
