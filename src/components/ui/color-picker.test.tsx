import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColorPicker } from "./color-picker";

afterEach(cleanup);

const TONES = { id: "tones", label: "Tones", colors: ["#FFF1A6", "#FFCC00", "#D3E4FF", "#BE123C"], columns: 2 };

function renderPicker(value = "#112233", extra: Partial<Parameters<typeof ColorPicker>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ColorPicker label="Color" value={value} swatches={[TONES]} onConfirm={onConfirm} onCancel={onCancel} confirmLabel="Highlight" {...extra} />);
  return { onConfirm, onCancel };
}

describe("ColorPicker", () => {
  it("keeps a partial hex draft without committing it, and accepts a pasted # code", () => {
    const { onConfirm } = renderPicker();

    const hex = screen.getByRole("textbox", { name: "Hex color" });
    fireEvent.change(hex, { target: { value: "4455" } });
    expect(hex).toHaveValue("4455");
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /Highlight/ })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.change(hex, { target: { value: "#3349c4" } });
    fireEvent.click(screen.getByRole("button", { name: /Highlight/ }));
    expect(onConfirm).toHaveBeenCalledWith("#3349C4");
  });

  it("places the field's thumb by saturation and brightness, and keeps a gray's hue", () => {
    renderPicker("#FFFF00");

    const thumb = screen.getByRole("slider", { name: "Saturation and brightness" });
    expect(thumb.style.left).toBe("100%");
    expect(thumb.style.top).toBe("0%");
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("60");

    // Down to black and back: the hue survives, so brightness alone brings the yellow back.
    for (let step = 0; step < 10; step += 1) fireEvent.keyDown(thumb, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("textbox", { name: "Hex color" })).toHaveValue("000000");
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("60");
    for (let step = 0; step < 10; step += 1) fireEvent.keyDown(thumb, { key: "ArrowUp", shiftKey: true });
    expect(screen.getByRole("textbox", { name: "Hex color" })).toHaveValue("FFFF00");
  });

  it("selects a swatch as a draft and moves through the group with the arrow keys", () => {
    const { onConfirm } = renderPicker("#FFF1A6");

    const group = screen.getByRole("radiogroup", { name: "Tones" });
    const first = screen.getByRole("radio", { name: /#FFF1A6$/ });
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: /#D3E4FF$/ })).toHaveAttribute("aria-checked", "true");
    expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says whether black text reads on the color, and lightens one that does not", () => {
    renderPicker("#3B5BD6", {
      legibility: (hex) => (hex === "#3B5BD6" ? { ok: false, ratio: 2.7, fix: "#C9D4F6" } : { ok: true, ratio: 12.1 }),
    });

    expect(screen.getByRole("status")).toHaveTextContent("Too dark for black text2.7:1");
    fireEvent.click(screen.getByRole("button", { name: "Lighten" }));
    expect(screen.getByRole("textbox", { name: "Hex color" })).toHaveValue("C9D4F6");
    expect(screen.getByRole("status")).toHaveTextContent("Black text reads clearly12.1:1");
  });

  it("shows a useful color name and keeps cancel separate from confirm", () => {
    const { onConfirm, onCancel } = renderPicker("#FFFF00");

    expect(screen.getByText("Yellow")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /#FFCC00$/ }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("applies every change at once in live mode, with no footer", () => {
    const onChange = vi.fn();
    render(<ColorPicker label="Accent" value="#112233" swatches={[TONES]} onChange={onChange} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /#BE123C$/ }));
    expect(onChange).toHaveBeenLastCalledWith("#BE123C");
  });
});
