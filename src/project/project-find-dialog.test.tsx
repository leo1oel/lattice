import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ProjectFindDialog, type ProjectFindHit } from "./project-find-dialog";
import { activateAppLocale } from "../i18n";

type FindProps = ComponentProps<typeof ProjectFindDialog>;

const fileHit = (path: string, line: number, overrides: Partial<ProjectFindHit> = {}): ProjectFindHit => ({
  kind: "file",
  path,
  title: path.split("/").at(-1)!,
  snippet: "A distinctive latent alignment objective.",
  line,
  fileKind: "tex",
  ...overrides,
});

function renderFind(overrides: Partial<FindProps> = {}) {
  const props: FindProps = {
    open: true,
    busy: false,
    error: null,
    hits: [],
    onClose: vi.fn(),
    onSearch: vi.fn(),
    onOpenHit: vi.fn(),
    ...overrides,
  };
  const view = render(<ProjectFindDialog {...props} />);
  const input = () => screen.getByRole("searchbox", { name: /^(?:Find in project|在项目中查找)$/ });
  return {
    ...view,
    props,
    input,
    rerenderWith: (next: Partial<FindProps>) => view.rerender(<ProjectFindDialog {...Object.assign(props, next)} />),
    /** Types a query and lets the debounce fire. */
    search: (query: string) => {
      fireEvent.change(input(), { target: { value: query } });
      act(() => vi.advanceTimersByTime(180));
    },
  };
}

describe("ProjectFindDialog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    await activateAppLocale("en");
  });

  it("updates the panel title and search label when switching to Chinese", async () => {
    vi.useRealTimers();
    renderFind();
    expect(screen.getByText("Find in project")).toBeInTheDocument();
    await act(() => activateAppLocale("zh-CN"));
    expect(screen.getByText("在项目中查找")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "在项目中查找" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "在项目中查找" })).toBeInTheDocument();
    expect(screen.queryByText("Find in project")).not.toBeInTheDocument();
  });

  it("shows its placeholder, counts, empty state, and close label in Chinese", async () => {
    vi.useRealTimers();
    await activateAppLocale("zh-CN");
    vi.useFakeTimers();
    const { search, rerenderWith } = renderFind({
      hits: [fileHit("main.tex", 3), fileHit("intro.tex", 8), { kind: "paper", path: "p", title: "Attention", snippet: "", line: null }],
    });
    expect(screen.getByPlaceholderText("短语或关键词")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭 在项目中查找" })).toBeInTheDocument();
    search("image");
    expect(screen.getByText("2 个结果 · 1 篇论文")).toBeInTheDocument();
    rerenderWith({ hits: [] });
    search("zzq");
    expect(screen.getByText("未找到“zzq”的结果")).toBeInTheDocument();
    expect(screen.getByText("试试更短的短语或换个关键词")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "清除搜索" })).toHaveLength(2);
  });

  it("lists and announces file and paper hits by type, and opens the selected file line", () => {
    const { props, search } = renderFind({
      hits: [
        fileHit("sections/method.tex", 2),
        { kind: "paper", path: "paper-1", title: "Latent alignment", snippet: "A related paper." },
      ],
    });

    search("alignment");
    expect(screen.getByRole("status")).toHaveTextContent("1 hit · 1 paper");
    expect(screen.getByText("TEX file")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    fireEvent.click(screen.getByText("sections/method.tex:2"));
    expect(props.onOpenHit).toHaveBeenCalledWith("sections/method.tex", 2);
  });

  it("shows a useful zero-result state and clears back to the search field", () => {
    const { props, input } = renderFind();

    fireEvent.change(input(), { target: { value: "missing theorem" } });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");

    act(() => vi.advanceTimersByTime(180));
    expect(props.onSearch).toHaveBeenLastCalledWith("missing theorem");
    expect(screen.getByRole("status")).toHaveTextContent("0 hits");
    expect(screen.getByText("No results for “missing theorem”")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear search"));
    expect(input()).toHaveValue("");
    expect(input()).toHaveFocus();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces failures without presenting them as successful zero-result searches", () => {
    const { search, rerenderWith } = renderFind();

    search("missing theorem");
    rerenderWith({ error: "The search index could not be read." });

    expect(screen.getByRole("status")).toHaveTextContent("Search failed.");
    expect(screen.getByRole("alert")).toHaveTextContent("The search index could not be read.");
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  it("does not open stale results while a new query is pending", () => {
    const { props, input } = renderFind({ hits: [fileHit("sections/old.tex", 4)] });

    fireEvent.change(input(), { target: { value: "new query" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "F3" });

    expect(screen.queryByText("sections/old.tex:4")).not.toBeInTheDocument();
    expect(props.onOpenHit).not.toHaveBeenCalled();
  });

  it("counts matches by paper key, not title, while listing each match", async () => {
    const vit = "An Image is Worth 16x16 Words";
    const vitHit = (path: string, snippet: string, line?: number) => ({ kind: "paper", path, title: vit, snippet, line });
    const { search } = renderFind({
      hits: [
        fileHit("main.tex", 1), fileHit("main.tex", 4), fileHit("notes.md", 2),
        vitHit(".research/papers/2010.11929/paper.md", vit),
        vitHit(".research/papers/2010.11929/paper.md", "image patches", 12),
        vitHit(".research/papers/2010.11929/blog.md", "image recognition", 3),
        vitHit(".research/papers/vit-published/paper.md", "image classification", 8),
      ],
    });

    search("image");
    expect(screen.getByRole("status")).toHaveTextContent("3 hits · 2 papers");
    expect(screen.getAllByRole("button", { name: `Open paper result: ${vit}` })).toHaveLength(4);

    await act(() => activateAppLocale("zh-CN"));
    expect(screen.getByRole("status")).toHaveTextContent("3 个结果 · 2 篇论文");
  });

  it("opens paper results by click and keyboard", () => {
    const path = ".research/papers/1706.03762/blog.md";
    const { props, input, search } = renderFind({
      hits: [{ kind: "paper", path, title: "Attention Is All You Need", snippet: "A residual stream explanation.", line: 12 }],
    });

    search("residual stream");
    fireEvent.click(screen.getByRole("button", { name: "Open paper result: Attention Is All You Need" }));
    expect(props.onOpenHit).toHaveBeenLastCalledWith(path, 12);

    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onOpenHit).toHaveBeenLastCalledWith(path, 12);
    expect(props.onOpenHit).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/indexed full-text index/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open hit" })).not.toBeInTheDocument();
  });

  it("does not open a result when Enter commits a Chinese IME candidate", () => {
    const { props, input, search } = renderFind({
      hits: [fileHit("references.bib", 2, { snippet: "Chen, Alice", fileKind: "bib" })],
    });

    search("陈");
    fireEvent.compositionStart(input());
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: "Enter", code: "Enter", keyCode: 13, isComposing: false });

    expect(props.onOpenHit).not.toHaveBeenCalled();
    expect(input()).toBeInTheDocument();
  });

  it("keeps late results hidden after the search is closed and reopened", () => {
    const { props, input, search, rerenderWith } = renderFind();

    search("late result");
    fireEvent.click(screen.getByRole("button", { name: "Close Find in project" }));

    const lateHits = [fileHit("sections/late.tex", 8, { snippet: "A result from the closed request." })];
    rerenderWith({ open: false, hits: lateHits });
    rerenderWith({ open: true });

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText("sections/late.tex:8")).not.toBeInTheDocument();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onOpenHit).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowDown then Enter opens the second hit", ["ArrowDown", "Enter"], "b.tex"],
    ["ArrowDown stops at the last hit", ["ArrowDown", "ArrowDown", "Enter"], "b.tex"],
    ["ArrowUp stops at the first hit", ["ArrowUp", "Enter"], "a.tex"],
    ["F3 steps forward and opens", ["F3"], "b.tex"],
    ["Shift-F3 wraps backwards and opens", ["Shift+F3"], "b.tex"],
  ])("navigates hits from the keyboard: %s", (_case, keys, expected) => {
    const { props, input, search } = renderFind({ hits: [fileHit("a.tex", 1), fileHit("b.tex", 2)] });

    search("alignment");
    for (const key of keys) {
      fireEvent.keyDown(input(), key === "Shift+F3" ? { key: "F3", shiftKey: true } : { key });
    }
    expect(props.onOpenHit).toHaveBeenLastCalledWith(expected, expected === "a.tex" ? 1 : 2);
  });
});
