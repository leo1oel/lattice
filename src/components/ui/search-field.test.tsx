import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField } from "./search-field";

afterEach(cleanup);

const field = () => document.querySelector('[data-slot="search-field"]');
const icon = () => document.querySelector(".ui-search-field-icon");

describe("SearchField", () => {
  it("provides the shared search semantics and leading icon by default", () => {
    render(<SearchField aria-label="Search files" placeholder="Search files…" />);
    const input = screen.getByRole("searchbox", { name: "Search files" });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("role", "searchbox");
    expect(input).toHaveAttribute("data-slot", "search-field-input");
    expect(field()).toHaveAttribute("data-control-size", "default");
    expect(icon()).toBeInTheDocument();
  });

  it("supports compact content search with trailing controls that own clearing", () => {
    render(
      <SearchField
        aria-label="Search PDF" value="attention" onChange={() => undefined} controlSize="compact" showIcon={false}
        trailing={<button type="button">Clear PDF search</button>}
      />,
    );
    expect(field()).toHaveAttribute("data-control-size", "compact");
    expect(icon()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear PDF search" })).toBeInTheDocument();
    // A specialized search owns its clear action; the shared one is not added.
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("uses the shared plain X clear action when a caller opts in", () => {
    const onClear = vi.fn();
    render(<SearchField aria-label="Search files" value="notes" onChange={() => undefined} onClear={onClear} />);
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.querySelector("svg")).toHaveClass("lucide-x");
    expect(clear.querySelector(".lucide-circle-x")).not.toBeInTheDocument();
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledOnce();
  });
});
