import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileDiffView } from "./file-diff-view";

const pierreState = vi.hoisted(() => ({
  attached: true,
  highlighterLoaded: true,
  preloadHighlighter: vi.fn(() => Promise.resolve()),
}));

vi.mock("@pierre/diffs", () => ({
  areLanguagesAttached: () => pierreState.attached,
  areThemesAttached: () => pierreState.attached,
  getFiletypeFromFileName: (path: string) => {
    if (path.endsWith(".tex")) return "tex";
    if (path.endsWith(".bib")) return "bibtex";
    if (path.endsWith(".md")) return "markdown";
    return "typescript";
  },
  isHighlighterLoaded: () => pierreState.highlighterLoaded,
  preloadHighlighter: pierreState.preloadHighlighter,
  registerCustomLanguage: vi.fn(),
  registerCustomTheme: vi.fn(),
  parseDiffFromFile: (
    oldFile: { name: string; contents: string; lang: string },
    newFile: { contents: string; lang: string },
  ) => ({
    name: oldFile.name,
    lang: oldFile.lang,
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
    fileDiff: { name: string; lang: string; type: string; deletionLines: string[]; additionLines: string[] };
    options: {
      disableFileHeader?: boolean;
      onLineClick?: (line: { lineNumber: number }) => void;
      unsafeCSS?: string;
    };
  }) => (
    <button
      type="button"
      data-testid="pierre-file-diff"
      data-name={props.fileDiff.name}
      data-language={props.fileDiff.lang}
      data-change-type={props.fileDiff.type}
      data-old={props.fileDiff.deletionLines.join("\n")}
      data-new={props.fileDiff.additionLines.join("\n")}
      data-header-disabled={String(props.options.disableFileHeader)}
      data-unsafe-css={props.options.unsafeCSS}
      onClick={() => props.options.onLineClick?.({ lineNumber: 7 })}
    >
      Pierre diff
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  pierreState.attached = true;
  pierreState.highlighterLoaded = true;
  pierreState.preloadHighlighter.mockClear();
});

describe("FileDiffView", () => {
  it("renders modified, added, and deleted files through one plain Pierre surface", () => {
    const { rerender } = render(
      <FileDiffView change={{ path: "main.tex", before: "old", after: "new" }} />,
    );
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "change");
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-language", "tex");
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-header-disabled", "true");
    expect(screen.getByTestId("pierre-file-diff").getAttribute("data-unsafe-css")).toContain(
      "--diffs-line-height: var(--type-diff-code-line-height)",
    );
    expect(screen.getByTestId("pierre-file-diff").getAttribute("data-unsafe-css")).toContain(
      "[data-code]:hover::-webkit-scrollbar-thumb",
    );
    expect(screen.getByTestId("pierre-file-diff").getAttribute("data-unsafe-css")).toContain(
      "background: transparent !important",
    );

    rerender(<FileDiffView change={{ path: "added.tex", before: null, after: "new" }} />);
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "new");
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-name", "added.tex");

    rerender(<FileDiffView change={{ path: "deleted.tex", before: "old", after: null }} />);
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-change-type", "deleted");
    expect(screen.queryByText("Rendering diff…")).not.toBeInTheDocument();

    rerender(<FileDiffView change={{ path: "script.ts", before: "old", after: "new" }} />);
    expect(screen.getByTestId("pierre-file-diff")).toHaveAttribute("data-language", "text");
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
    expect(screen.getByText("No textual changes")).toBeInTheDocument();

    rerender(<FileDiffView change={{ path: "empty.tex", before: null, after: "" }} />);
    expect(screen.getByText("Empty file added")).toBeInTheDocument();
    expect(screen.queryByTestId("pierre-file-diff")).not.toBeInTheDocument();
  });

  it("renders as soon as the current preload completes without requiring a remount", async () => {
    pierreState.attached = false;
    pierreState.highlighterLoaded = false;

    render(<FileDiffView change={{ path: "main.tex", before: "old", after: "new" }} />);

    expect(screen.getByText("Rendering diff…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("pierre-file-diff")).toBeInTheDocument());
    expect(pierreState.preloadHighlighter).toHaveBeenCalledWith({
      themes: ["github-light"],
      langs: ["tex"],
    });
  });

});
