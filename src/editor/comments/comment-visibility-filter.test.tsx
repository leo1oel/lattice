import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentVisibilityFilter } from "./comment-visibility-filter";

afterEach(cleanup);

describe("CommentVisibilityFilter", () => {
  it("marks the selected visibility with the shared compact selected state", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CommentVisibilityFilter showResolved={false} onChange={onChange} openLabel="Open" resolvedLabel="All" />,
    );
    const open = screen.getByRole("button", { name: "Open" });
    const all = screen.getByRole("button", { name: "All" });
    expect(screen.getByRole("group", { name: "Comment visibility" })).toContainElement(open);
    expect(open).toHaveClass("ui-compact-selectable", "active");
    expect(open).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveClass("ui-compact-selectable");
    expect(all).not.toHaveClass("active");
    expect(all).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(all);
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<CommentVisibilityFilter showResolved onChange={onChange} openLabel="Open" resolvedLabel="All" />);
    expect(all).toHaveClass("active");
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(open).not.toHaveClass("active");

    fireEvent.click(open);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
