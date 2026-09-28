import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleColorPicker } from "./apple-color-picker";

afterEach(cleanup);

function renderPicker(value = "#112233", opacity?: number) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<AppleColorPicker value={value} opacity={opacity} onConfirm={onConfirm} onCancel={onCancel} />);
  return { onConfirm, onCancel };
}

describe("AppleColorPicker", () => {
  it("keeps a partial hex draft without committing it", () => {
    const { onConfirm } = renderPicker();

    fireEvent.click(screen.getByRole("tab", { name: "Slider" }));
    const hex = screen.getByRole("textbox", { name: "Hex color" });
    fireEvent.change(hex, { target: { value: "4455" } });
    expect(hex).toHaveValue("4455");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses the shared sliding tabs and animates the selected grid swatch", () => {
    renderPicker("#FFFF00", 100);

    expect(document.querySelector(".sliding-tab-pill")).not.toBeNull();
    const nextSwatch = screen.getByRole("button", { name: "Select #BE123C" });
    fireEvent.click(nextSwatch);

    expect(nextSwatch).toHaveAttribute("aria-pressed", "true");
    expect(nextSwatch.querySelector(".highlight-color-selection")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Spectrum" }));
    const spectrum = screen.getByRole("application", { name: "Color spectrum" });
    const thumb = spectrum.querySelector<HTMLElement>(".highlight-spectrum-thumb");
    expect(Number.parseFloat(thumb?.style.getPropertyValue("--spectrum-x") ?? "")).toBeCloseTo(95.93, 1);
    expect(Number.parseFloat(thumb?.style.getPropertyValue("--spectrum-y") ?? "")).toBeCloseTo(9.47, 1);
    expect(Number.parseFloat(spectrum.style.getPropertyValue("--spectrum-value"))).toBeCloseTo(74.51, 1);
  });

  it("keeps percentage decoration outside the value and supports wheel stepping", () => {
    const { onConfirm } = renderPicker("#112233", 50);

    const opacity = screen.getByRole("spinbutton", { name: "Opacity value" });
    expect(opacity).toHaveValue(50);
    expect(opacity.parentElement).toHaveTextContent("%");
    fireEvent.wheel(opacity, { deltaY: -1 });
    fireEvent.click(screen.getByRole("button", { name: "Apply highlight color" }));
    expect(onConfirm).toHaveBeenCalledWith("#112233", 51);
  });

  it("steps RGB values with the wheel and keeps slider thumbs inside their tracks", () => {
    renderPicker("#112233", 0);

    const opacityThumb = document.querySelector<HTMLElement>(".highlight-opacity-thumb");
    expect(opacityThumb?.style.getPropertyValue("--slider-position")).toBe("0%");
    fireEvent.click(screen.getByRole("tab", { name: "Slider" }));
    fireEvent.wheel(screen.getByRole("spinbutton", { name: "Red value" }), { deltaY: -1 });
    const thumbs = document.querySelectorAll<HTMLElement>(".highlight-slider-thumb");
    expect(Number.parseFloat(thumbs[0].style.getPropertyValue("--slider-position"))).toBeCloseTo(7.06, 2);
    expect(thumbs[0]).toHaveStyle({ backgroundColor: "#120000" });
    expect(thumbs[1]).toHaveStyle({ backgroundColor: "#002200" });
    expect(thumbs[2]).toHaveStyle({ backgroundColor: "#000033" });
  });

  it("caps recent colors at eight while moving additions to the front", () => {
    renderPicker("#112233", 100);

    expect(screen.getAllByRole("button", { name: /^Recent color/ })).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "Add current color" }));

    expect(screen.getAllByRole("button", { name: /^Recent color/ })).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Recent color #112233" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("shows a useful color name and keeps cancel separate from confirm", () => {
    const { onConfirm, onCancel } = renderPicker("#FFFF00");

    expect(screen.getByText("Yellow")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select #FFCC00" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel color selection" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
