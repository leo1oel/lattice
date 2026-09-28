import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { SlidingTabs, StateSwap } from "./motion";

afterEach(cleanup);

describe("StateSwap", () => {
  it("shows the initial state without an entrance and replaces stale labels immediately", () => {
    const { container, rerender } = render(<StateSwap swapKey="idle">Build</StateSwap>);
    expect(screen.getByText("Build")).toHaveStyle({ opacity: "1" });
    rerender(<StateSwap swapKey="building">Stop</StateSwap>);
    expect(screen.queryByText("Build")).toBeNull();
    expect(screen.getByText("Stop")).toBeInTheDocument();
    rerender(<StateSwap swapKey="success">1.7s</StateSwap>);
    expect(screen.queryByText("Stop")).toBeNull();
    expect(container.querySelectorAll(".state-swap")).toHaveLength(1);
  });
});

describe("SlidingTabs", () => {
  const items = [{ value: "a", label: "First" }, { value: "b", label: "Second" }];

  function Harness() {
    const [value, setValue] = useState("a");
    return <SlidingTabs value={value} onChange={setValue} items={items} ariaLabel="Views" />;
  }

  it("marks one tab selected, reports changes, keeps one moving indicator, and moves focus with arrow keys", () => {
    const { container } = render(<Harness />);
    const first = screen.getByRole("tab", { name: "First" });
    const second = screen.getByRole("tab", { name: "Second" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveAttribute("aria-selected", "false");
    expect(container.querySelectorAll(".sliding-tab-pill")).toHaveLength(1);
    // The harness only selects what onChange reports.
    fireEvent.click(second);
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(container.querySelectorAll(".sliding-tab-pill")).toHaveLength(1);
    expect(second.querySelector(".sliding-tab-pill")).not.toBeNull();
    fireEvent.click(first);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveFocus();
  });

  it("leaves selection styling to the tab when asked for no indicator", () => {
    const { container } = render(
      <SlidingTabs value="a" onChange={() => {}} items={items} ariaLabel="Views" variant="none" />,
    );
    expect(container.querySelector(".sliding-tab-pill")).toBeNull();
    expect(screen.getByRole("tab", { name: "First" })).toHaveClass("active");
  });
});
