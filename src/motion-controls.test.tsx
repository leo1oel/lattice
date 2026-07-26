import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { SlidingTabs, Switch } from "./motion";

afterEach(cleanup);

describe("Switch", () => {
  it("reports the new state and stays a real switch for assistive tech", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Enable docs" onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Enable docs" });
    expect(control).toHaveAttribute("aria-checked", "false");

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked disabled label="Enable docs" onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable docs" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("SlidingTabs", () => {
  const items = [
    { value: "a", label: "First" },
    { value: "b", label: "Second" },
  ];

  it("marks one tab selected and reports a change", () => {
    const onChange = vi.fn();
    render(<SlidingTabs value="a" onChange={onChange} items={items} ariaLabel="Views" />);
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "false");

    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("keeps exactly one indicator, so it moves rather than multiplies", () => {
    function Harness() {
      const [value, setValue] = useState("a");
      return <SlidingTabs value={value} onChange={setValue} items={items} ariaLabel="Views" />;
    }
    const { container } = render(<Harness />);
    expect(container.querySelectorAll(".sliding-tab-pill")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Second" }));
    expect(container.querySelectorAll(".sliding-tab-pill")).toHaveLength(1);
    expect(
      screen.getByRole("tab", { name: "Second" }).querySelector(".sliding-tab-pill"),
    ).not.toBeNull();
  });

  it("draws an underline instead of a pill when asked", () => {
    const { container } = render(
      <SlidingTabs value="a" onChange={() => {}} items={items} ariaLabel="Views" variant="underline" />,
    );
    expect(container.querySelector(".sliding-tab-underline")).not.toBeNull();
    expect(container.querySelector(".sliding-tab-pill")).toBeNull();
  });
});
