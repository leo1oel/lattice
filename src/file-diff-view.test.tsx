import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDiffView } from "./file-diff-view";

vi.mock("@pierre/diffs", () => ({
  areLanguagesAttached: () => true,
  areThemesAttached: () => true,
  getFiletypeFromFileName: () => "latex",
  isHighlighterLoaded: () => true,
  preloadHighlighter: vi.fn(),
  parseDiffFromFile: (oldFile: { name: string; contents: string }, newFile: { contents: string }) => ({
    name: oldFile.name,
    type: "change",
    hunks: [],
    splitLineCount: 2,
    unifiedLineCount: 2,
    isPartial: false,
    deletionLines: oldFile.contents.split("\n"),
    additionLines: newFile.contents.split("\n"),
  }),
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: {
    fileDiff: { name: string; type: string; deletionLines: string[]; additionLines: string[] };
    options: { disableFileHeader?: boolean; onLineClick?: (line: { lineNumber: number }) => void };
  }) => (
    <button
      type="button"
      data-testid="pierre-file-diff"
      data-name={props.fileDiff.name}
      data-change-type={props.fileDiff.type}
      data-old={props.fileDiff.deletionLines.join("\n")}
      data-new={props.fileDiff.additionLines.join("\n")}
      data-header-disabled={String(props.options.disableFileHeader)}
      onClick={() => props.options.onLineClick?.({ lineNumber: 7 })}
    >
      Pierre diff
    </button>
  ),
}));

afterEach(cleanup);

describe("FileDiffView", () => {
  it("renders modified, added, and deleted files through one plain Pierre surface", () => {
    const { rerender } = render(
      <FileDiffView change={{ path: "main.tex", before: "old", after: "new" }} />,
    );
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "change");
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-header-disabled", "true");

    rerender(<FileDiffView change={{ path: "added.tex", before: null, after: "new" }} />);
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "new");
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-name", "added.tex");

    rerender(<FileDiffView change={{ path: "deleted.tex", before: "old", after: null }} />);
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "deleted");
    expect(screen.queryByText("Rendering diff…")).not.toBeInTheDocument();
  });

  it("switches content and forwards line clicks without retaining the previous file", () => {
    const onOpenLine = vi.fn();
    const { rerender } = render(
      <FileDiffView
        change={{ path: "first.tex", before: "old first", after: "new first" }}
        onOpenLine={onOpenLine}
      />,
    );
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-new", "new first");

    rerender(
      <FileDiffView
        change={{ path: "second.tex", before: "old second", after: "new second" }}
        onOpenLine={onOpenLine}
      />,
    );
    const viewer = screen.getByTestId("pierre-file-diff");
    expect(viewer).toHaveAttribute("data-name", "second.tex");
    expect(viewer).toHaveAttribute("data-new", "new second");
    expect(viewer).not.toHaveAttribute("data-new", "new first");

    fireEvent.click(viewer);
    expect(onOpenLine).toHaveBeenCalledWith("second.tex", 7);
  });

  it("shows explicit states for unchanged and empty added files", () => {
    const { rerender } = render(
      <FileDiffView change={{ path: "same.tex", before: "same", after: "same" }} />,
    );
    expect(screen.getByText("No textual changes.")).toBeInTheDocument();

    rerender(<FileDiffView change={{ path: "empty.tex", before: null, after: "" }} />);
    expect(screen.getByText("Empty file added.")).toBeInTheDocument();
    expect(screen.queryByTestId("pierre-file-diff")).not.toBeInTheDocument();
  });
});
