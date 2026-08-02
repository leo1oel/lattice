import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleColorPicker } from "./apple-color-picker";

afterEach(cleanup);

describe("AppleColorPicker", () => {
  it("keeps a partial hex draft until the committed color changes", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      <AppleColorPicker
        value="#112233"
        onValueChange={onValueChange}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Slider" }));
    const hex = screen.getByRole("textbox", { name: "Hex color" });
    fireEvent.change(hex, { target: { value: "4455" } });
    expect(hex).toHaveValue("4455");
    expect(onValueChange).not.toHaveBeenCalled();

    rerender(
      <AppleColorPicker
        value="#AABBCC"
        onValueChange={onValueChange}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Hex color" }))
      .toHaveValue("AABBCC");
  });
});
