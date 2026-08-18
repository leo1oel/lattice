import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverleafPreview } from "../app-types";
import { OverleafReviewDialog } from "./overleaf-review";

const pierreState = vi.hoisted(() => ({
  itemTops: new Map<string, number>(),
  scrollTo: vi.fn(),
  scrollTop: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@pierre/diffs", () => ({
  parseDiffFromFile: (
    before: { name: string; contents: string; lang: string; cacheKey: string },
    after: { contents: string; cacheKey: string },
  ) => ({
    name: before.name,
    lang: before.lang,
    type: "change",
    hunks: [],
    before: before.contents,
    after: after.contents,
    cacheKey: `${before.cacheKey}:${after.cacheKey}`,
  }),
}));
vi.mock("../history/file-diff-view", () => ({
  PIERRE_UNSAFE_CSS: "pierre styles",
  pierreLanguageForPath: (path: string) => path.endsWith(".tex") ? "tex" : "text",
  usePierreResources: () => ({
    error: undefined,
    languages: ["tex", "text"],
    ready: true,
    theme: "light",
    themeName: "github-light",
  }),
}));
vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function MockCodeView(props: {
    items: Array<{
      id: string;
      fileDiff: { name: string; after: string; cacheKey: string };
      version: number;
    }>;
    onScroll?: (
      scrollTop: number,
      viewer: { getTopForItem: (id: string) => number | undefined },
    ) => void;
    renderHeaderPrefix: (item: { id: string }) => React.ReactNode;
  }, ref) {
    useImperativeHandle(ref, () => ({ scrollTo: pierreState.scrollTo }));
    return (
      <div
        data-testid="code-view"
        onScroll={() => props.onScroll?.(pierreState.scrollTop, {
          getTopForItem: (id) => pierreState.itemTops.get(id),
        })}
      >
        {props.items.map((item) => (
          <section
            key={item.id}
            data-testid="code-view-item"
            data-path={item.fileDiff.name}
            data-after={item.fileDiff.after}
            data-cache-key={item.fileDiff.cacheKey}
            data-version={item.version}
          >
            {props.renderHeaderPrefix(item)}
            {item.fileDiff.name}
          </section>
        ))}
      </div>
    );
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pierreState.itemTops.clear();
  pierreState.scrollTop = 0;
});

describe("OverleafReviewDialog", () => {
  it("renders every text change in one CodeView and uses the file list as navigation", async () => {
    const preview: OverleafPreview = {
      remoteVersion: 42,
      changes: [
        { path: "incoming.tex", kind: "incoming", before: "old", after: "new", binary: false },
        { path: "figure.pdf", kind: "incoming", before: null, after: null, binary: true },
        { path: "conflict.tex", kind: "conflict", before: "mine", after: "marked", binary: false },
        { path: "notes.txt", kind: "outgoing", before: "before", after: "after", binary: false },
      ],
    };
    vi.mocked(invoke).mockResolvedValue(preview);

    render(
      <OverleafReviewDialog
        open
        projectRoot="/project"
        onClose={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(await screen.findByText(/4 files would change · 1 needs your decision/)).toBeInTheDocument();
    const renderedPaths = screen.getAllByTestId("code-view-item")
      .map((item) => item.getAttribute("data-path"));
    expect(renderedPaths).toEqual(["conflict.tex", "incoming.tex", "notes.txt"]);
    expect(screen.getByText("figure.pdf").closest("button")).toBeDisabled();
    expect(screen.getAllByTestId("code-view-item")[0]).toHaveAttribute("data-version", "1");
    const firstCacheKey = screen.getAllByTestId("code-view-item")
      .find((item) => item.getAttribute("data-path") === "incoming.tex")
      ?.getAttribute("data-cache-key");

    vi.mocked(invoke).mockResolvedValue({
      ...preview,
      changes: preview.changes.map((change) => change.path === "incoming.tex"
        ? { ...change, after: "newer" }
        : change),
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      const incoming = screen.getAllByTestId("code-view-item")
        .find((item) => item.getAttribute("data-path") === "incoming.tex");
      expect(incoming).toHaveAttribute("data-after", "newer");
      expect(incoming).toHaveAttribute("data-version", "2");
      expect(incoming?.getAttribute("data-cache-key")).not.toBe(firstCacheKey);
    });

    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(pierreState.scrollTo).toHaveBeenCalledWith({
      type: "item",
      id: "overleaf:notes.txt",
      align: "start",
      behavior: "smooth",
    }));

    fireEvent.click(screen.getByRole("button", { name: "conflict.tex" }));
    expect(screen.getByRole("button", { name: "conflict.tex" })).toHaveAttribute("aria-current", "true");
    pierreState.itemTops.set("overleaf:conflict.tex", 0);
    pierreState.itemTops.set("overleaf:incoming.tex", 80);
    pierreState.itemTops.set("overleaf:notes.txt", 160);
    pierreState.scrollTop = 161;
    fireEvent.scroll(screen.getByTestId("code-view"));
    expect(screen.getByRole("button", { name: "notes.txt" })).toHaveAttribute("aria-current", "true");
  });

  it("ignores an older preview request after the project changes", async () => {
    let resolveFirst!: (preview: OverleafPreview) => void;
    let resolveSecond!: (preview: OverleafPreview) => void;
    vi.mocked(invoke).mockImplementation(async (_command, args) => new Promise((resolve) => {
      if ((args as { projectRoot: string }).projectRoot === "/first") resolveFirst = resolve;
      else resolveSecond = resolve;
    }));

    const { rerender } = render(
      <OverleafReviewDialog
        open
        projectRoot="/first"
        onClose={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    rerender(
      <OverleafReviewDialog
        open
        projectRoot="/second"
        onClose={vi.fn()}
        onApply={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await act(async () => resolveSecond({
      remoteVersion: 2,
      changes: [{ path: "second.tex", kind: "incoming", before: "old", after: "new", binary: false }],
    }));
    expect(await screen.findByRole("button", { name: "second.tex" })).toBeInTheDocument();

    await act(async () => resolveFirst({
      remoteVersion: 1,
      changes: [{ path: "first.tex", kind: "incoming", before: "old", after: "new", binary: false }],
    }));
    expect(screen.getByRole("button", { name: "second.tex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "first.tex" })).not.toBeInTheDocument();
  });
});
