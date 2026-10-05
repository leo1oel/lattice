import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import { PaperLibrary } from "./paper-library";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

type PaperLibraryProps = ComponentProps<typeof PaperLibrary>;

const attention: PaperSummary = {
  arxivId: "1706.03762",
  title: "Attention Is All You Need",
  authors: "Vaswani and Shazeer",
  citationKey: "vaswani2017",
  hasFullText: true,
  hasBlog: false,
};

const vit: PaperSummary = {
  arxivId: "2010.11929",
  title: "An Image Is Worth 16x16 Words",
  authors: "Dosovitskiy",
  citationKey: "dosovitskiy2021",
  hasFullText: false,
  hasBlog: false,
};

function baseProps(): PaperLibraryProps {
  return {
    projectKey: "/tmp/paper",
    papers: [attention, vit],
    activePaper: null,
    onReveal: vi.fn(),
    onPaper: vi.fn(),
    onFetchFullText: vi.fn(),
    paperFetchStates: {},
    onDeletePaper: vi.fn(),
    onEditBibEntry: vi.fn(),
    importInput: "",
    setImportInput: vi.fn(),
    onImport: vi.fn(),
    onCancelImport: vi.fn(),
    importing: false,
  };
}

/**
 * The search box is a controlled input owned by App, so a test drives the query
 * the way App does: type, take the reported value, re-render with it.
 */
function renderLibrary(overrides?: Partial<PaperLibraryProps>) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<PaperLibrary {...props} />);
  const rerenderWith = (next: Partial<PaperLibraryProps>) => {
    Object.assign(props, next);
    view.rerender(<PaperLibrary {...props} />);
  };
  return {
    ...view,
    props,
    rerenderWith,
    search: (query: string) => {
      fireEvent.change(searchbox(), { target: { value: query } });
      rerenderWith({ importInput: query });
    },
  };
}

const searchbox = () => screen.getByRole("searchbox", { name: "Search or import papers" });

/** While an import or fetch runs, the search box is the read-only progress surface. */
function expectImportProgress(active: boolean) {
  const input = searchbox();
  expect(input).toHaveAttribute("aria-busy", String(active));
  expect(input.hasAttribute("readonly")).toBe(active);
  expect(input.getAttribute("aria-describedby")).toBe(active ? "paper-import-status" : null);
  expect(document.querySelector(".paper-import-track > span") !== null).toBe(active);
}

function paperTitles() {
  return Array.from(document.querySelectorAll(".paper-row .paper-open"))
    .map((button) => button.querySelector("strong")?.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets the debounced full-text search run and settle. */
const settleTextSearch = () => act(async () => { await vi.advanceTimersByTimeAsync(200); });

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
});

describe("PaperLibrary", () => {
  // Only a paper already held with full text opens instead; every other
  // submission imports, which also repairs a missing full text.
  it.each([
    ["https://arxiv.org/pdf/1706.03762v3", true],
    ["https://arxiv.org/pdf/2010.11929", false],
    ["https://example.org/1706.03762", false],
    ["A study of 1706.03762", false],
  ])("opens rather than reimports %s only when it is readable (%s)", (input, opens) => {
    const { props } = renderLibrary({ importInput: input });
    fireEvent.click(screen.getByRole("button", { name: "Add paper" }));
    expect(vi.mocked(props.onPaper).mock.calls).toEqual(opens ? [[attention]] : []);
    expect(props.onImport).toHaveBeenCalledTimes(opens ? 0 : 1);
  });

  it("lists the whole library until something is typed, and says when the library is empty", () => {
    const { rerenderWith } = renderLibrary();
    expect(paperTitles()).toEqual(["Attention Is All You Need", "An Image Is Worth 16x16 Words"]);
    expect(screen.getByText("2 papers")).toBeInTheDocument();

    rerenderWith({ papers: [] });
    expect(screen.getByText("Add your first paper")).toBeInTheDocument();
    expect(screen.queryByText("No matching papers")).toBeNull();
  });

  // Each token has to match somewhere in the entry, so a second word can only
  // ever shorten the list — that is what makes typing feel like searching.
  // Pasting a link is how a paper is imported, so the same paste has to find
  // the copy already in the library instead of offering to fetch it again.
  it.each([
    ["a single word", "image", [vit.title]],
    ["every word, not just the first", "image vaswani", []],
    ["authors the row never shows", "dosovitskiy", [vit.title]],
    ["citation keys the row never shows", "vaswani2017", [attention.title]],
    ["a pasted arXiv URL with a versioned id", "https://arxiv.org/abs/2010.11929v3", [vit.title]],
    ["a pasted DOI URL against the normalized DOI", "https://doi.org/10.48550/arXiv.1706.03762", [attention.title]],
  ])("filters the library by %s", (_case, query, titles) => {
    const { search } = renderLibrary({ papers: [{ ...attention, doi: "10.48550/arXiv.1706.03762" }, vit] });

    search(query);
    expect(paperTitles()).toEqual(titles);
    expect(screen.getByText(titles.length ? "1 of 2 papers" : "No matching papers")).toBeInTheDocument();
  });

  it("starts empty and shows pipeline stages without changing the submitted query", () => {
    const { props, rerenderWith } = renderLibrary({
      importInput: "graph transformers",
      importing: true,
      importStage: "Resolving citation metadata…",
      importStageId: "resolving",
    });

    const fill = () => document.querySelector(".paper-import-track > span");
    expect(fill()).toHaveStyle({ width: "0%" });
    const input = searchbox();
    expectImportProgress(true);
    expect(screen.getByRole("status")).toHaveTextContent("Resolving citation metadata…");
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancelImport).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    for (const [importStageId, importStage] of [
      ["fulltext", "Downloading full text and figures…"],
      ["overview", "Fetching the paper overview…"],
    ] as const) {
      rerenderWith({ importStage, importStageId });
      expect(screen.getByRole("status").textContent).toBe(importStage);
      expect(fill()).toHaveStyle({ width: "0%" });
      expect(input).toHaveValue("graph transformers");
    }
    rerenderWith({ importStage: undefined, importStageId: "future-stage" });
    expect(screen.getByRole("status")).toHaveTextContent("Working…");
    expect(fill()).not.toHaveStyle({ width: "100%" });
    expect(document.querySelector(".paper-import-step")).toBeNull();
    rerenderWith({ importing: false });
    expect(screen.queryByRole("status")).toBeNull();
    expectImportProgress(false);
    expect(input).toHaveValue("graph transformers");
  });

  it("keeps import progress across stage changes and resets only when the task ends", () => {
    let now = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => { frames.delete(key); });
    const tick = (time: number) => act(() => {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
    });
    const { rerenderWith } = renderLibrary({ importing: true, importStageId: "resolving" });
    const width = () => parseFloat(document.querySelector<HTMLElement>(".paper-import-track > span")!.style.width);
    tick(2000);
    expect(width()).toBeCloseTo(14.85);
    tick(3000);
    expect(width()).toBeCloseTo(22.275);
    rerenderWith({ importStageId: "fulltext" });
    tick(9000);
    expect(width()).toBeCloseTo(41.95125);
    rerenderWith({ importing: false });
    rerenderWith({ importing: true, importStageId: "resolving" });
    tick(10000);
    expect(width()).toBeCloseTo(7.425);
  });

  it("shows download progress until the last loading paper finishes without enabling import cancellation", () => {
    const { props, rerenderWith } = renderLibrary({
      importInput: "Adam",
      paperFetchStates: { first: "loading", second: "loading" },
      importStageId: "fulltext",
      importStage: "Downloading full text and figures…",
    });
    expectImportProgress(true);
    expect(screen.getByRole("button", { name: "Add paper" })).toBeDisabled();
    fireEvent.keyDown(searchbox(), { key: "Enter" });
    expect(props.onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Downloading full text and figures…");
    rerenderWith({ paperFetchStates: { first: "success", second: "loading" }, importStageId: "overview", importStage: "Fetching the paper overview…" });
    expect(screen.getByRole("status")).toHaveTextContent("Fetching the paper overview…");
    // Failed fetches are removed; successful ones linger briefly for the row checkmark.
    rerenderWith({ paperFetchStates: { first: "success" } });
    expect(screen.queryByRole("status")).toBeNull();
    expectImportProgress(false);
    expect(searchbox()).toHaveValue("Adam");
    expect(screen.getByRole("button", { name: "Add paper" })).toBeEnabled();
  });

  it("ranks a title prefix ahead of metadata and full-text matches", async () => {
    vi.useFakeTimers();
    const spatial = { ...attention, citationKey: "spatial", arxivId: "2501.00001", title: "S-Space: Exploring Spatial Workspace in Multimodal Models" };
    const metadata = { ...vit, authors: "The S-Space Consortium" };
    const titleMatch = { ...vit, citationKey: "evaluating", arxivId: "2501.00002", title: "Evaluating S-Space representations" };
    const exact = { ...vit, citationKey: "exact", arxivId: "2501.00003", title: "S-Space" };
    vi.mocked(invoke).mockResolvedValue([
      { arxivId: attention.arxivId, title: attention.title, snippet: "We evaluate s-space representations." },
    ]);
    const { search } = renderLibrary({ papers: [attention, metadata, titleMatch, spatial, exact] });
    search("s-space");
    await settleTextSearch();
    expect(paperTitles()).toEqual([exact.title, spatial.title, titleMatch.title, metadata.title, attention.title]);
  });

  it("keeps a freshly imported paper visible under its retained raw URL query", () => {
    const rawUrl = "https://publisher.example/article/opaque-id";
    const imported = {
      ...attention,
      arxivId: "",
      title: "Resolved Publisher Title",
      url: "https://canonical.example/paper",
    };
    const { rerenderWith } = renderLibrary({ importInput: rawUrl, papers: [vit] });

    rerenderWith({ importing: true });
    rerenderWith({ papers: [vit, imported] });
    rerenderWith({ importing: false, recentImport: { query: rawUrl, citationKey: imported.citationKey, arxivId: "" } });

    expect(searchbox()).toHaveValue(rawUrl);
    expect(paperTitles()).toEqual(["Resolved Publisher Title"]);
  });

  it("brings the confirmed import to the top and releases it when the query changes", () => {
    const { rerenderWith, search } = renderLibrary({ importInput: "a" });
    const viewport = screen.getByRole("list", { name: "Papers" });
    viewport.scrollTop = 200;
    rerenderWith({ recentImport: { query: "a", citationKey: vit.citationKey, arxivId: vit.arxivId } });
    expect(paperTitles()[0]).toBe(vit.title);
    expect(viewport.scrollTop).toBe(0);
    search("attention");
    expect(paperTitles()).toEqual([attention.title]);
  });

  it.each(["open", "fetch", "import"])("never tries to %s a paper on Enter", (action) => {
    const paper = { ...attention, title: "中文论文", hasFullText: action === "open" };
    const { props } = renderLibrary({ importInput: "中文", papers: action === "import" ? [] : [paper] });
    const input = searchbox();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onPaper).not.toHaveBeenCalled();
    expect(props.onFetchFullText).not.toHaveBeenCalled();
    expect(props.onImport).not.toHaveBeenCalled();
  });

  it("searches the full text at once on Enter, but not while an IME candidate is confirmed", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue([
      { arxivId: "1706.03762", title: "Attention Is All You Need", snippet: "scaled dot-product" },
    ]);
    const { search } = renderLibrary();
    search("dot-product");
    const input = searchbox();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    act(() => vi.advanceTimersByTime(0));
    // No pause in typing needed: Enter is the request to search now.
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("search_paper_library", { query: "dot-product" });
    expect(paperTitles()).toEqual(["Attention Is All You Need"]);
    // The debounced pass this replaced must not search a second time.
    await settleTextSearch();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("adds only through the labeled + button", () => {
    const { props, search } = renderLibrary();
    expect(document.querySelector(".import-box .ui-search-field-icon")).not.toBeNull();
    const add = screen.getByRole("button", { name: "Add paper" });
    expect(add).toBeDisabled();
    search("something nobody has");
    fireEvent.keyDown(searchbox(), { key: "Enter" });
    expect(props.onImport).not.toHaveBeenCalled();
    fireEvent.click(add);
    expect(props.onImport).toHaveBeenCalledOnce();
  });

  it("shows each paper's authors and source under its title, and its exact citation key apart", () => {
    const web: PaperSummary = {
      arxivId: "web-0123456789abcdef", url: "https://www.example.org/notes", title: "Notes",
      authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki", hasFullText: true, hasBlog: false,
    };
    renderLibrary({ papers: [attention, { ...vit, authors: undefined }, web] });
    const [first, second, third] = screen.getAllByRole("button", { name: /Attention|Image|Notes/ })
      .filter((button) => button.classList.contains("paper-open"));
    const byline = (row: HTMLElement) => [...row.querySelector(".paper-byline")!.children].map((part) => part.textContent);
    expect(first.querySelector(".paper-authors")).toHaveTextContent("Vaswani and Shazeer");
    expect(byline(first)).toEqual(["Vaswani and Shazeer", "arXiv 1706.03762"]);
    expect(first.querySelector(".paper-cite-key")).toHaveTextContent("vaswani2017");
    expect(second.querySelector(".paper-authors")).toBeNull();
    expect(byline(second)).toEqual(["arXiv 2010.11929"]);
    // A captured page's bundle key is never presented as an arXiv id, and a
    // paper without a citation key has no empty chip.
    expect(byline(third)).toEqual(["Vaswani et al.", "example.org"]);
    expect(third.querySelector(".paper-cite-key")).toBeNull();
  });

  it("tags a paper with nothing to download as a citation, beside its key", () => {
    const cited: PaperSummary = { arxivId: "", title: "Cited Work", citationKey: "cited2020", hasFullText: false, hasBlog: false };
    renderLibrary({ papers: [vit, cited] });
    const [fetchable, citation] = [...document.querySelectorAll<HTMLElement>(".paper-row .paper-tags")];
    expect([...citation.children].map((tag) => tag.textContent)).toEqual(["cited2020", "Citation only"]);
    // An arXiv preprint downloads on click, so it is not tagged.
    expect([...fetchable.children].map((tag) => tag.textContent)).toEqual(["dosovitskiy2021"]);
  });

  it("names a corporate author whole, and finds it without its braces", () => {
    // The author field as `list_papers` delivers it, braces kept.
    const gemini: PaperSummary = { ...vit, arxivId: "2312.11805", title: "Gemini", authors: "{Gemini Team} and Mc{D}onald, Ronald", citationKey: "gemini" };
    const { search } = renderLibrary({ papers: [attention, gemini] });
    const row = screen.getAllByRole("button", { name: /Gemini/ }).find((button) => button.classList.contains("paper-open"))!;
    expect(row.querySelector(".paper-authors")).toHaveTextContent(/^Gemini Team and McDonald$/);

    search("mcdonald");
    expect(paperTitles()).toEqual(["Gemini"]);
  });

  it("waits for a pause in typing, then adds papers whose text matched even when their metadata did not", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue([
      { arxivId: "1706.03762", title: "Attention Is All You Need", snippet: "  scaled dot-product  " },
    ]);
    const { search } = renderLibrary();

    search("dot");
    search("dot-");
    search("dot-product");
    expect(paperTitles()).toEqual([]);

    await settleTextSearch();

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("search_paper_library", { query: "dot-product" });
    expect(paperTitles()).toEqual(["Attention Is All You Need"]);
    // The matching line replaces the usual subtitle, so the hit is visible.
    expect(screen.getByText("scaled dot-product")).toBeInTheDocument();
  });

  it("keeps filtering by metadata when the full-text index cannot be read", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockRejectedValue(new Error("index missing"));
    const { search } = renderLibrary();

    search("attention");
    await settleTextSearch();

    expect(paperTitles()).toEqual(["Attention Is All You Need"]);
  });

});

