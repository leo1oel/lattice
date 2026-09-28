import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverleafPreview } from "../app-types";
import { OverleafReviewDialog } from "./overleaf-review";
import { pierreView } from "../history/pierre-test-mocks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@pierre/diffs", async () => (await import("../history/pierre-test-mocks")).pierreDiffsMock);
vi.mock("@pierre/diffs/react", async () => ({ CodeView: (await import("../history/pierre-test-mocks")).MockCodeView }));
vi.mock("../history/pierre-diff", async (importOriginal) => ({
  ...await importOriginal<object>(),
  usePierreResources: (await import("../history/pierre-test-mocks")).readyPierreResources,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pierreView.reset();
});

const dialog = (projectRoot: string) => (
  <OverleafReviewDialog open projectRoot={projectRoot} onClose={vi.fn()} onApply={vi.fn().mockResolvedValue(undefined)} />
);
type Change = OverleafPreview["changes"][number];
const textChange = (path: string, kind: Change["kind"] = "incoming", before = "old", after = "new"): Change => ({ path, kind, before, after, binary: false });
const codeViewItem = (path: string) => screen.getAllByTestId("code-view-item").find((item) => item.getAttribute("data-path") === path);

describe("OverleafReviewDialog", () => {
  it("renders every text change in one CodeView and uses the file list as navigation", async () => {
    const preview: OverleafPreview = {
      remoteVersion: 42,
      changes: [
        textChange("incoming.tex"),
        { path: "figure.pdf", kind: "incoming", before: null, after: null, binary: true },
        textChange("conflict.tex", "conflict", "mine", "marked"),
        textChange("notes.txt", "outgoing", "before", "after"),
      ],
    };
    vi.mocked(invoke).mockResolvedValue(preview);

    render(dialog("/project"));

    expect(await screen.findByText(/4 files would change · 1 needs your decision/)).toBeInTheDocument();
    const renderedPaths = screen.getAllByTestId("code-view-item")
      .map((item) => item.getAttribute("data-path"));
    expect(renderedPaths).toEqual(["conflict.tex", "incoming.tex", "notes.txt"]);
    expect(screen.getByText("figure.pdf").closest("button")).toBeDisabled();
    expect(screen.getAllByTestId("code-view-item")[0]).toHaveAttribute("data-version", "1");
    const firstCacheKey = codeViewItem("incoming.tex")?.getAttribute("data-cache-key");

    vi.mocked(invoke).mockResolvedValue({
      ...preview,
      changes: preview.changes.map((change) => change.path === "incoming.tex"
        ? { ...change, after: "newer" }
        : change),
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      const incoming = codeViewItem("incoming.tex");
      expect(incoming).toHaveAttribute("data-after", "newer");
      expect(incoming).toHaveAttribute("data-version", "2");
      expect(incoming?.getAttribute("data-cache-key")).not.toBe(firstCacheKey);
    });

    fireEvent.click(screen.getByRole("button", { name: "notes.txt" }));
    await waitFor(() => expect(pierreView.scrollTo).toHaveBeenCalledWith({
      type: "item", id: "overleaf:notes.txt", align: "start", behavior: "smooth",
    }));

    fireEvent.click(screen.getByRole("button", { name: "conflict.tex" }));
    expect(screen.getByRole("button", { name: "conflict.tex" })).toHaveAttribute("aria-current", "true");
    pierreView.itemTops.set("overleaf:conflict.tex", 0);
    pierreView.itemTops.set("overleaf:incoming.tex", 80);
    pierreView.itemTops.set("overleaf:notes.txt", 160);
    pierreView.scrollTop = 161;
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

    const { rerender } = render(dialog("/first"));
    rerender(dialog("/second"));

    await act(async () => resolveSecond({ remoteVersion: 2, changes: [textChange("second.tex")] }));
    expect(await screen.findByRole("button", { name: "second.tex" })).toBeInTheDocument();

    await act(async () => resolveFirst({ remoteVersion: 1, changes: [textChange("first.tex")] }));
    expect(screen.getByRole("button", { name: "second.tex" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "first.tex" })).not.toBeInTheDocument();
  });
});
