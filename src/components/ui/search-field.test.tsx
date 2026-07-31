import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField } from "./search-field";

afterEach(cleanup);

describe("SearchField", () => {
  it("provides the shared search semantics and leading icon by default", () => {
    const { container } = render(
      <SearchField aria-label="Search files" placeholder="Search files…" />,
    );

    const input = screen.getByRole("searchbox", { name: "Search files" });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("role", "searchbox");
    expect(input).toHaveAttribute("data-slot", "search-field-input");
    expect(container.querySelector('[data-slot="search-field"]')).toHaveAttribute(
      "data-control-size",
      "default",
    );
    expect(container.querySelector(".ui-search-field-icon")).toBeInTheDocument();
  });

  it("supports compact content search and trailing result controls", () => {
    const { container } = render(
      <SearchField
        aria-label="Find in PDF"
        controlSize="compact"
        showIcon={false}
        trailing={<button type="button">Next</button>}
      />,
    );

    expect(container.querySelector('[data-slot="search-field"]')).toHaveAttribute(
      "data-control-size",
      "compact",
    );
    expect(container.querySelector(".ui-search-field-icon")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("uses the shared plain X clear action when a caller opts in", () => {
    const onClear = vi.fn();
    render(
      <SearchField
        aria-label="Search files"
        value="notes"
        onChange={() => undefined}
        onClear={onClear}
      />,
    );

    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.querySelector("svg")).toHaveClass("lucide-x");
    expect(clear.querySelector(".lucide-circle-x")).not.toBeInTheDocument();
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("does not add the shared clear action when a specialized search owns it", () => {
    render(
      <SearchField
        aria-label="Search PDF"
        value="attention"
        onChange={() => undefined}
        showIcon={false}
        trailing={<button type="button">Clear PDF search</button>}
      />,
    );

    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear PDF search" })).toBeInTheDocument();
    expect(document.querySelector(".ui-search-field-icon")).not.toBeInTheDocument();
  });
});
