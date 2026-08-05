import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryDrawer } from "./history-drawer";

const pierreState = vi.hoisted(() => ({
  itemTops: new Map<string, number>(),
  scrollTo: vi.fn(),
  scrollTop: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./file-diff-view", () => ({
  FileDiffView: () => <div data-testid="single-file-diff" />,
  PIERRE_UNSAFE_CSS: "pierre styles",
  pierreLanguageForPath: (path: string) => path.endsWith(".tex") ? "tex" : "text",
  usePierreResources: () => ({
    error: undefined,
    languages: ["tex"],
    ready: true,
    theme: "light",
    themeName: "github-light",
  }),
}));
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
vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function MockCodeView(props: {
    items: Array<{ id: string; fileDiff: { name: string } }>;
    onScroll?: (
      scrollTop: number,
      viewer: { getTopForItem: (id: string) => number | undefined },
    ) => void;
    options: {
      onLineClick?: (
        line: { lineNumber: number },
        context: { item: { id: string; type: "diff"; fileDiff: { name: string } } },
      ) => void;
    };
    renderHeaderMetadata: (item: { id: string }) => React.ReactNode;
  }, ref) {
    useImperativeHandle(ref, () => ({ scrollTo: pierreState.scrollTo }));
    return (
      <div
        data-testid="history-code-view"
        onScroll={() => props.onScroll?.(pierreState.scrollTop, {
          getTopForItem: (id) => pierreState.itemTops.get(id),
        })}
      >
        {props.items.map((item) => (
          <div
            key={item.id}
            data-testid="history-code-view-item"
            data-path={item.fileDiff.name}
            onClick={() => props.options.onLineClick?.(
              { lineNumber: 7 },
              { item: { ...item, type: "diff" } },
            )}
          >
            {props.renderHeaderMetadata(item)} {item.fileDiff.name}
          </div>
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

describe("HistoryDrawer multi-file review", () => {
  it("reviews one transaction in CodeView and keeps navigation and per-file restore", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_status") return { repository: true, dirty: false, files: [] };
      if (command === "git_log") return [];
      if (command === "get_history_entry") {
        return {
          id: "tx-1",
          label: "Update two files",
          timestamp: "2026-08-04T12:00:00Z",
          changes: [
            { path: "main.tex", before: "old main", after: "new main" },
            { path: "methods.tex", before: "old methods", after: "new methods" },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const onClose = vi.fn();
    const onOpenFile = vi.fn();
    const onRevertFile = vi.fn();

    render(
      <HistoryDrawer
        history={[{
          id: "tx-1",
          label: "Update two files",
          timestamp: "2026-08-04T12:00:00Z",
          files: ["main.tex", "methods.tex"],
        }]}
        onClose={onClose}
        onDelete={vi.fn()}
        onRevert={vi.fn()}
        onRevertFile={onRevertFile}
        onOpenFile={onOpenFile}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: /Update two files/ }));
    expect(await screen.findByTestId("history-code-view")).toBeInTheDocument();
    expect(screen.getAllByTestId("history-code-view-item").map((item) => item.dataset.path))
      .toEqual(["main.tex", "methods.tex"]);
    expect(screen.queryByTestId("single-file-diff")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "methods.tex" }));
    expect(pierreState.scrollTo).toHaveBeenCalledWith({
      type: "item",
      id: "history:tx-1:1",
      align: "start",
      behavior: "smooth",
    });
    fireEvent.click(screen.getByTitle("Restore only methods.tex"));
    expect(onRevertFile).toHaveBeenCalledWith("tx-1", "methods.tex");

    fireEvent.click(screen.getByRole("button", { name: "main.tex" }));
    expect(screen.getByRole("button", { name: "main.tex" })).toHaveAttribute("aria-current", "true");
    const codeView = screen.getByTestId("history-code-view");
    pierreState.itemTops.set("history:tx-1:0", 0);
    pierreState.itemTops.set("history:tx-1:1", 80);
    pierreState.scrollTop = 81;
    fireEvent.scroll(codeView);
    expect(screen.getByRole("button", { name: "methods.tex" })).toHaveAttribute("aria-current", "true");

    pierreState.scrollTo.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(pierreState.scrollTo).toHaveBeenCalledWith({
      type: "item",
      id: "history:tx-1:1",
      align: "start",
      behavior: "smooth",
    }));

    fireEvent.click(screen.getAllByTestId("history-code-view-item")[1]!);
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("methods.tex", 7));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores an older transaction request that resolves after the current one", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "git_status") return { repository: true, dirty: false, files: [] };
      if (command === "git_log") return [];
      if (command === "get_history_entry") {
        const id = (args as { transactionId: string }).transactionId;
        return new Promise((resolve) => {
          if (id === "tx-a") resolveFirst = resolve;
          else resolveSecond = resolve;
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(
      <HistoryDrawer
        history={[
          { id: "tx-a", label: "First transaction", timestamp: "2026-08-04T12:00:00Z", files: ["a.tex"] },
          { id: "tx-b", label: "Second transaction", timestamp: "2026-08-04T12:01:00Z", files: ["b.tex"] },
        ]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onRevert={vi.fn()}
        onRevertFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    fireEvent.click(screen.getByRole("button", { name: /First transaction/ }));
    fireEvent.click(screen.getByRole("button", { name: /Second transaction/ }));
    await act(async () => resolveSecond({
      id: "tx-b",
      label: "Second transaction",
      timestamp: "2026-08-04T12:01:00Z",
      changes: [{ path: "b.tex", before: "old b", after: "new b" }],
    }));
    expect(await screen.findByTestId("single-file-diff")).toBeInTheDocument();

    await act(async () => resolveFirst({
      id: "tx-a",
      label: "First transaction",
      timestamp: "2026-08-04T12:00:00Z",
      changes: [{ path: "a.tex", before: "old a", after: "new a" }],
    }));
    expect(screen.getByTitle("Restore only b.tex")).toBeInTheDocument();
    expect(screen.queryByTitle("Restore only a.tex")).not.toBeInTheDocument();
  });
});
