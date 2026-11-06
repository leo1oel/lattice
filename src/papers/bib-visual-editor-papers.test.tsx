import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { BibVisualEditor } from "./bib-visual-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

const VIEW_HEIGHT = 600;
const ROW = 60;

const preprint = "@article{vaswani,\n  title = {Attention Is All You Need},\n  eprint = {1706.03762},\n  archiveprefix = {arXiv},\n  year = {2017}\n}\n";
const doiOnly = "@article{hewitt,\n  title = {A Structural Probe},\n  doi = {10.18653/v1/N19-1419},\n  year = {2019}\n}\n";
const webPage = "@misc{blog,\n  title = {A Blog Post},\n  url = {https://example.com/post}\n}\n";

// Each test its own file: the list remembers the reference in front by path.
let file = 0;

function renderEditor(source: string, props: Partial<ComponentProps<typeof BibVisualEditor>> = {}) {
  const onOpenPaper = vi.fn();
  render(
    <BibVisualEditor
      path={`references-${(file += 1)}.bib`}
      source={source}
      projectRoot="/project"
      editable
      papers={[]}
      usageRevision={0}
      onChange={() => true}
      onUndo={() => false}
      onRedo={() => false}
      onOpenLine={vi.fn()}
      onOpenPaper={onOpenPaper}
      onOpenUrl={vi.fn()}
      onResolveCitation={vi.fn()}
      {...props}
    />,
  );
  return { onOpenPaper, list: screen.getByRole("listbox", { name: "References" }) };
}

const detail = () => within(document.querySelector<HTMLElement>(".bib-visual-detail")!);
const option = (title: string) => screen.getAllByRole("option").find((row) => row.textContent?.includes(title))!;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "listbox" ? VIEW_HEIGHT : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BibVisualEditor / opening a reference's paper", () => {
  it("offers Download and open for a preprint the library has not fetched, and hands it to the Papers download", () => {
    const { onOpenPaper } = renderEditor(preprint);
    fireEvent.click(option("Attention"));
    fireEvent.click(detail().getByRole("button", { name: "Download and open" }));
    expect(onOpenPaper).toHaveBeenCalledWith(expect.objectContaining({ arxivId: "1706.03762", citationKey: "vaswani", hasFullText: false }));
  });

  it("opens the library's own paper when its full text is there", () => {
    const paper: PaperSummary = { arxivId: "1706.03762", title: "Attention Is All You Need", citationKey: "Vaswani", hasFullText: true, hasBlog: false };
    const { onOpenPaper } = renderEditor(preprint, { papers: [paper] });
    // The row's own control opens it without bringing the detail up.
    fireEvent.click(within(option("Attention")).getByRole("button", { name: "Open paper" }));
    expect(onOpenPaper).toHaveBeenCalledWith(paper);
    expect(screen.queryByRole("heading", { name: "Attention Is All You Need" })).toBeNull();
    expect(option("Attention").getAttribute("aria-selected")).toBe("false");
  });

  it("shows the download under way and takes no second click", () => {
    const { onOpenPaper } = renderEditor(preprint, { paperFetchStates: { "1706.03762": "loading" } });
    fireEvent.click(option("Attention"));
    const downloading = screen.getAllByRole("button", { name: "Downloading…" });
    expect(downloading).toHaveLength(2);
    for (const button of downloading) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button);
    }
    expect(onOpenPaper).not.toHaveBeenCalled();
  });

  it("downloads a cited web page by its address", () => {
    const { onOpenPaper } = renderEditor(webPage);
    fireEvent.click(within(option("Blog Post")).getByRole("button", { name: "Download and open" }));
    expect(onOpenPaper).toHaveBeenCalledWith(expect.objectContaining({ arxivId: "", url: "https://example.com/post" }));
  });

  it("says why there is nothing to open for a reference with only a DOI", () => {
    renderEditor(doiOnly);
    expect(within(option("Structural Probe")).queryByRole("button")).toBeNull();
    fireEvent.click(option("Structural Probe"));
    expect(screen.getByText("No full text to download")).toBeTruthy();
    expect(detail().queryByRole("button", { name: /open/i })).toBeNull();
  });
});

describe("BibVisualEditor / beside its source in Split", () => {
  const ENTRIES = 40;
  const source = Array.from({ length: ENTRIES }, (_, index) => (
    `@article{key${index},\n  title = {Entry ${index}},\n  year = {2020}\n}\n`
  )).join("\n");

  function renderSplit() {
    const view = new EditorView({ state: EditorState.create({ doc: source }), parent: document.body });
    const cursorRef = createRef<(() => void) | null>() as { current: (() => void) | null };
    cursorRef.current = null;
    const rendered = renderEditor(source, { sourceView: view, cursorRef });
    return { ...rendered, view, cursorRef };
  }

  it("brings the reference under the source's cursor into view and in front", () => {
    vi.useFakeTimers();
    const { view, cursorRef, list } = renderSplit();
    vi.spyOn(view, "hasFocus", "get").mockReturnValue(true);
    const at = source.indexOf("title = {Entry 30}");
    view.dispatch({ selection: { anchor: at } });
    act(() => {
      cursorRef.current?.();
      vi.advanceTimersByTime(100);
    });
    expect(list.scrollTop).toBeGreaterThan(20 * ROW);
    // jsdom fires no scroll event for a scroll a script makes.
    fireEvent.scroll(list);
    expect(screen.getByRole("option", { selected: true }).id).toBe("bib-row-30");
    view.destroy();
  });

  it("leaves the list alone when the cursor moves in an editor that is not focused", () => {
    vi.useFakeTimers();
    const { view, cursorRef } = renderSplit();
    view.dispatch({ selection: { anchor: source.indexOf("Entry 12") } });
    act(() => {
      cursorRef.current?.();
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole("option", { selected: true })).toBeNull();
    view.destroy();
  });

  it("marks a reference clicked in the list in the source, keeping the keyboard in the list", () => {
    const { view } = renderSplit();
    fireEvent.click(screen.getByText("Entry 3"));
    const from = source.indexOf("@article{key3,");
    const { main } = view.state.selection;
    expect(main.from).toBe(from);
    expect(source.slice(main.from, main.to).trimEnd()).toBe("@article{key3,\n  title = {Entry 3},\n  year = {2020}\n}");
    expect(view.hasFocus).toBe(false);
    view.destroy();
  });

  it("stops following once it is gone", () => {
    const { view, cursorRef } = renderSplit();
    expect(cursorRef.current).toBeTypeOf("function");
    cleanup();
    expect(cursorRef.current).toBeNull();
    view.destroy();
  });
});
