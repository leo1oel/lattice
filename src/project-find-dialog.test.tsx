import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectFindDialog } from "./project-find-dialog";

describe("ProjectFindDialog", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lists hits and opens the selected file line", () => {
    vi.useFakeTimers();
    const onOpenHit = vi.fn();
    const onSearch = vi.fn();
    render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[
          {
            kind: "file",
            path: "sections/method.tex",
            title: "method.tex",
            snippet: "A distinctive latent alignment objective.",
            line: 2,
          },
        ]}
        onClose={() => undefined}
        onSearch={onSearch}
        onOpenHit={onOpenHit}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in project" }), {
      target: { value: "alignment" },
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.click(screen.getByText("sections/method.tex:2"));
    expect(onOpenHit).toHaveBeenCalledWith("sections/method.tex", 2);
  });

  it("announces the result count and labels file and paper result types in text", () => {
    vi.useFakeTimers();
    render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[
          {
            kind: "file",
            path: "sections/method.tex",
            title: "method.tex",
            snippet: "A distinctive latent alignment objective.",
            line: 2,
            fileKind: "tex",
          },
          {
            kind: "paper",
            path: "paper-1",
            title: "Latent alignment",
            snippet: "A related paper.",
          },
        ]}
        onClose={() => undefined}
        onSearch={() => undefined}
        onOpenHit={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in project" }), {
      target: { value: "alignment" },
    });
    act(() => vi.advanceTimersByTime(180));
    expect(screen.getByRole("status")).toHaveTextContent("1 hit · 1 paper");
    expect(screen.getByText("TEX file")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
  });

  it("shows a useful zero-result state and clears back to the search field", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[]}
        onClose={() => undefined}
        onSearch={onSearch}
        onOpenHit={() => undefined}
      />,
    );

    const input = screen.getByRole("searchbox", { name: "Find in project" });
    fireEvent.change(input, { target: { value: "missing theorem" } });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");

    act(() => vi.advanceTimersByTime(180));
    expect(onSearch).toHaveBeenLastCalledWith("missing theorem");
    expect(screen.getByRole("status")).toHaveTextContent("0 hits");
    expect(screen.getByText("No results for “missing theorem”")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear search"));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Type to search the project.");
  });

  it("announces failures without presenting them as successful zero-result searches", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[]}
        onClose={() => undefined}
        onSearch={() => undefined}
        onOpenHit={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in project" }), {
      target: { value: "missing theorem" },
    });
    act(() => vi.advanceTimersByTime(180));
    rerender(
      <ProjectFindDialog
        open
        busy={false}
        error="The search index could not be read."
        hits={[]}
        onClose={() => undefined}
        onSearch={() => undefined}
        onOpenHit={() => undefined}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Search failed.");
    expect(screen.getByRole("alert")).toHaveTextContent("The search index could not be read.");
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  it("does not open stale results while a new query is pending", () => {
    vi.useFakeTimers();
    const onOpenHit = vi.fn();
    render(
      <ProjectFindDialog
        open
        busy={false}
        error={null}
        hits={[{
          kind: "file",
          path: "sections/old.tex",
          title: "old.tex",
          snippet: "An earlier result.",
          line: 4,
          fileKind: "tex",
        }]}
        onClose={() => undefined}
        onSearch={() => undefined}
        onOpenHit={onOpenHit}
      />,
    );

    const input = screen.getByRole("searchbox", { name: "Find in project" });
    fireEvent.change(input, { target: { value: "new query" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "F3" });

    expect(screen.queryByText("sections/old.tex:4")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open hit" })).toBeDisabled();
    expect(onOpenHit).not.toHaveBeenCalled();
  });

  it("keeps late results hidden after the search is closed and reopened", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onOpenHit = vi.fn();
    const baseProps = {
      busy: false,
      error: null,
      onClose,
      onSearch: vi.fn(),
      onOpenHit,
    };
    const { rerender } = render(
      <ProjectFindDialog {...baseProps} open hits={[]} />,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in project" }), {
      target: { value: "late result" },
    });
    act(() => vi.advanceTimersByTime(180));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    const lateHits = [{
      kind: "file",
      path: "sections/late.tex",
      title: "late.tex",
      snippet: "A result from the closed request.",
      line: 8,
      fileKind: "tex",
    }];
    rerender(<ProjectFindDialog {...baseProps} open={false} hits={lateHits} />);
    rerender(<ProjectFindDialog {...baseProps} open hits={lateHits} />);

    expect(screen.getByRole("status")).toHaveTextContent("Type to search the project.");
    expect(screen.queryByText("sections/late.tex:8")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open hit" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find in project" }), { key: "Enter" });
    expect(onOpenHit).not.toHaveBeenCalled();
  });
});
