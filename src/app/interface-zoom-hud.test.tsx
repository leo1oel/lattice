import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterfaceZoomHud } from "./interface-zoom-hud";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("InterfaceZoomHud", () => {
  it("shows the new size for a moment after a change, longer while the pointer is on it", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { container, rerender } = render(<InterfaceZoomHud scale={1} revealKey={0} onChange={onChange} />);
    const hud = container.querySelector(".interface-zoom-hud")!;
    expect(hud).not.toHaveAttribute("data-shown");
    rerender(<InterfaceZoomHud scale={1.2} revealKey={1} onChange={onChange} />);
    expect(hud).toHaveAttribute("data-shown");
    expect(screen.getByRole("status")).toHaveTextContent("120%");
    fireEvent.pointerEnter(hud);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(hud).toHaveAttribute("data-shown");
    fireEvent.pointerLeave(hud);
    act(() => { vi.advanceTimersByTime(1_700); });
    expect(hud).not.toHaveAttribute("data-shown");
  });

  it("steps and resets from its buttons, each disabled where it has nowhere to go", () => {
    const onChange = vi.fn();
    render(<InterfaceZoomHud scale={1.35} revealKey={1} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Larger interface" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Smaller interface" }));
    fireEvent.click(screen.getByRole("button", { name: /Reset/ }));
    expect(onChange.mock.calls).toEqual([["out"], ["reset"]]);
  });
});
