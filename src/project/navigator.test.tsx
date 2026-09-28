import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { FileNode, PaperSummary } from "../app-types";
import { Navigator } from "./navigator";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

type NavigatorProps = ComponentProps<typeof Navigator>;

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

const files: FileNode[] = [
  {
    name: "sections",
    path: "sections",
    kind: "directory",
    children: [
      { name: "intro.tex", path: "sections/intro.tex", kind: "tex", children: [] },
    ],
  },
  { name: "main.tex", path: "main.tex", kind: "tex", children: [] },
];

function baseProps(): NavigatorProps {
  return {
    mode: "papers",
    projectKey: "/tmp/paper",
    searchOpen: false,
    onSearchOpenChange: vi.fn(),
    files,
    gitStatus: [],
    activeFile: "main.tex",
    activeAssetPath: "",
    protectedPaths: [],
    papers: [attention, vit],
    activePaper: null,
    onFile: vi.fn(),
    onAsset: vi.fn(),
    onBeginFigureDrag: vi.fn(),
    onBeginFileDrag: vi.fn(),
    onCreateEntry: vi.fn(async (path: string) => path),
    onDeleteEntries: vi.fn(),
    onRenameEntry: vi.fn(async (path: string) => path),
    onMoveEntries: vi.fn(async (paths: string[]) => paths),
    onCopyEntries: vi.fn(async (paths: string[]) => paths),
    onError: vi.fn(),
    onReveal: vi.fn(),
    onImportAssets: vi.fn(),
    onPasteImage: vi.fn(),
    assetDropTarget: null,
    assetImporting: false,
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
function renderNavigator(overrides?: Partial<NavigatorProps>) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<Navigator {...props} />);
  const rerenderWith = (next: Partial<NavigatorProps>) => {
    Object.assign(props, next);
    view.rerender(<Navigator {...props} />);
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
  vi.mocked(writeText).mockReset().mockResolvedValue();
  vi.mocked(readText).mockReset().mockResolvedValue("");
});

describe("Navigator / papers", () => {
  // Only a paper already held with full text opens instead; every other
  // submission imports, which also repairs a missing full text.
  it.each([
    ["https://arxiv.org/pdf/1706.03762v3", true],
    ["https://arxiv.org/pdf/2010.11929", false],
    ["https://example.org/1706.03762", false],
    ["A study of 1706.03762", false],
  ])("opens rather than reimports %s only when it is readable (%s)", (input, opens) => {
    const { props } = renderNavigator({ importInput: input });
    fireEvent.click(screen.getByTitle("Import paper"));
    expect(vi.mocked(props.onPaper).mock.calls).toEqual(opens ? [[attention]] : []);
    expect(props.onImport).toHaveBeenCalledTimes(opens ? 0 : 1);
  });

  it("lists the whole library until something is typed, and says when the library is empty", () => {
    const { rerenderWith } = renderNavigator();
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
    const { search } = renderNavigator({ papers: [{ ...attention, doi: "10.48550/arXiv.1706.03762" }, vit] });

    search(query);
    expect(paperTitles()).toEqual(titles);
    expect(screen.getByText(titles.length ? "1 of 2 papers" : "No matching papers")).toBeInTheDocument();
  });

  it("starts empty and shows pipeline stages without changing the submitted query", () => {
    const { props, rerenderWith } = renderNavigator({
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

  it("preserves import progress across sidebar switches and resets only when the task ends", () => {
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
    const { rerenderWith } = renderNavigator({ importing: true, importStageId: "resolving" });
    const width = () => parseFloat(document.querySelector<HTMLElement>(".paper-import-track > span")!.style.width);
    tick(2000);
    expect(width()).toBeCloseTo(14.85);
    // App maps both Project and Agent to Navigator's project mode.
    rerenderWith({ mode: "project" });
    tick(3000);
    rerenderWith({ mode: "papers" });
    expect(width()).toBeCloseTo(22.275);
    rerenderWith({ mode: "project", importStageId: "fulltext" });
    tick(9000);
    rerenderWith({ mode: "papers" });
    expect(width()).toBeCloseTo(41.95125);
    rerenderWith({ mode: "project", importing: false });
    rerenderWith({ importing: true, importStageId: "resolving" });
    tick(10000);
    rerenderWith({ mode: "papers" });
    expect(width()).toBeCloseTo(7.425);
  });

  it("shows download progress until the last loading paper finishes without enabling import cancellation", () => {
    const { props, rerenderWith } = renderNavigator({
      importInput: "Adam",
      paperFetchStates: { first: "loading", second: "loading" },
      importStageId: "fulltext",
      importStage: "Downloading full text and figures…",
    });
    expectImportProgress(true);
    expect(screen.getByTitle("Import paper")).toBeDisabled();
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
    expect(screen.getByTitle("Import paper")).toBeEnabled();
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
    const { search } = renderNavigator({ papers: [attention, metadata, titleMatch, spatial, exact] });
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
    const { rerenderWith } = renderNavigator({ importInput: rawUrl, papers: [vit] });

    rerenderWith({ importing: true });
    rerenderWith({ papers: [vit, imported] });
    rerenderWith({ importing: false, recentImport: { query: rawUrl, citationKey: imported.citationKey, arxivId: "" } });

    expect(searchbox()).toHaveValue(rawUrl);
    expect(paperTitles()).toEqual(["Resolved Publisher Title"]);
  });

  it("brings the confirmed import to the top and releases it when the query changes", () => {
    const { rerenderWith, search } = renderNavigator({ importInput: "a" });
    const viewport = screen.getByRole("list", { name: "Papers" });
    viewport.scrollTop = 200;
    rerenderWith({ recentImport: { query: "a", citationKey: vit.citationKey, arxivId: vit.arxivId } });
    expect(paperTitles()[0]).toBe(vit.title);
    expect(viewport.scrollTop).toBe(0);
    search("attention");
    expect(paperTitles()).toEqual([attention.title]);
  });

  it.each(["open", "fetch", "import"])("does not %s a paper when Enter confirms an IME candidate", (action) => {
    vi.useFakeTimers();
    const paper = { ...attention, title: "中文论文", hasFullText: action === "open" };
    const { props } = renderNavigator({ importInput: "中文", papers: action === "import" ? [] : [paper] });
    const input = searchbox();
    const expectNoAction = () => {
      expect(props.onPaper).not.toHaveBeenCalled();
      expect(props.onFetchFullText).not.toHaveBeenCalled();
      expect(props.onImport).not.toHaveBeenCalled();
    };

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expectNoAction();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expectNoAction();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    expectNoAction();
    // WebKit can finish composition before dispatching the accepting Enter.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 13, isComposing: false });
    expectNoAction();

    act(() => vi.advanceTimersByTime(0));
    fireEvent.keyDown(input, { key: "Enter" });
    const callback = action === "open" ? props.onPaper : action === "fetch" ? props.onFetchFullText : props.onImport;
    expect(callback).toHaveBeenCalledOnce();
  });

  it("opens the top match on Enter, and imports when there is none", () => {
    const { props, search } = renderNavigator();

    search("attention");
    fireEvent.keyDown(searchbox(), { key: "Enter" });
    expect(props.onPaper).toHaveBeenCalledWith(attention);

    // Cited-only: there is nothing local to open, so Enter fetches it.
    search("image");
    fireEvent.keyDown(searchbox(), { key: "Enter" });
    expect(props.onFetchFullText).toHaveBeenCalledWith(vit);

    search("something nobody has");
    fireEvent.keyDown(searchbox(), { key: "Enter" });
    expect(props.onImport).toHaveBeenCalledOnce();
  });

  it("waits for a pause in typing, then adds papers whose text matched even when their metadata did not", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue([
      { arxivId: "1706.03762", title: "Attention Is All You Need", snippet: "  scaled dot-product  " },
    ]);
    const { search } = renderNavigator();

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
    const { search } = renderNavigator();

    search("attention");
    await settleTextSearch();

    expect(paperTitles()).toEqual(["Attention Is All You Need"]);
  });

});

describe("Navigator / project tree", () => {
  const expansionKey = (projectKey: string) => `lattice:expanded-directories:${projectKey}`;
  const expandSections = () => localStorage.setItem(expansionKey("/tmp/paper"), JSON.stringify(["sections"]));

  function treeRoot(): ShadowRoot | null {
    return document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
  }

  function treeItem(path: string): HTMLElement | null {
    return Array.from(treeRoot()?.querySelectorAll<HTMLElement>("[data-item-path]") ?? [])
      .find((item) => item.dataset.itemPath === path) ?? null;
  }

  const findTreeItem = (path: string) => waitFor(() => {
    const item = treeItem(path);
    expect(item).not.toBeNull();
    return item!;
  });

  const textFile = (name: string) => ({ name, path: name, kind: "text", children: [] });

  async function hiddenFilesToggle(checked: boolean) {
    const toggle = await screen.findByRole("menuitemcheckbox", { name: "Show hidden files" });
    expect(toggle).toHaveAttribute("aria-checked", String(checked));
    expect(toggle.querySelector("svg")).toHaveClass(checked ? "lucide-check" : "lucide-eye");
    return toggle;
  }

  it("hides template files by default, then toggles hidden files from both menus and remembers the choice", async () => {
    const hidden = ["journal.sty", "refs.bst", "main.fls", ".env.example"].map(textFile);
    vi.mocked(invoke).mockResolvedValue([...files, ...hidden]);
    // By default only template files hide — not sources whose name merely starts like one.
    const view = renderNavigator({ mode: "project", files: [...files, ...["journal.sty", "refs.BST", "journal.sty.tex"].map(textFile)] });
    await waitFor(() => expect(treeItem("journal.sty.tex")).not.toBeNull());
    expect(treeItem("journal.sty")).toBeNull();
    expect(treeItem("refs.BST")).toBeNull();
    fireEvent.contextMenu(screen.getByLabelText("Project files"));
    fireEvent.click(await hiddenFilesToggle(false));
    await waitFor(() => expect(treeItem("main.fls")).not.toBeNull());
    expect(invoke).toHaveBeenCalledWith("list_project_tree_with_hidden", { projectRoot: "/tmp/paper" });
    for (const file of hidden) expect(treeItem(file.path)).not.toBeNull();
    expect(localStorage.getItem("lattice:show-hidden-files")).toBe("true");
    view.unmount();
    renderNavigator({ mode: "project" });
    await waitFor(() => expect(treeItem("main.fls")).not.toBeNull());
    fireEvent.contextMenu(treeItem("sections/")!);
    fireEvent.click(await hiddenFilesToggle(true));
    await waitFor(() => expect(treeItem("main.fls")).toBeNull());
    expect(localStorage.getItem("lattice:show-hidden-files")).toBe("false");
    fireEvent.contextMenu(treeItem("sections/")!);
    await hiddenFilesToggle(false);
  });

  it("ignores a hidden tree response from the previous project", async () => {
    localStorage.setItem("lattice:show-hidden-files", "true");
    let resolveOld!: (files: FileNode[]) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { rerenderWith } = renderNavigator({ mode: "project" });
    const otherFiles = [{ name: "other.tex", path: "other.tex", kind: "tex", children: [] }];
    vi.mocked(invoke).mockResolvedValue(otherFiles);
    rerenderWith({ projectKey: "/tmp/other", files: otherFiles });
    await waitFor(() => expect(treeItem("other.tex")).not.toBeNull());
    await act(async () => resolveOld(files));
    expect(treeItem("main.tex")).toBeNull();
    expect(treeItem("other.tex")).not.toBeNull();
  });

  it("reopens the folders the last session left open, keeping each project's folders to itself", async () => {
    // Stored without Pierre's trailing slash, which is the form the tree wants
    // back — a mismatch here silently collapses everyone's tree on restart.
    expandSections();
    const { rerenderWith } = renderNavigator({ mode: "project" });
    await waitFor(() => expect(treeItem("sections/intro.tex")).not.toBeNull());

    rerenderWith({ projectKey: "/tmp/other" });

    await waitFor(() => expect(treeItem("sections/intro.tex")).toBeNull());
    expect(treeItem("sections/")).not.toBeNull();
  });

  it("survives expansion state that is not a list of paths", async () => {
    // The key is plain JSON in localStorage: anything can be in it, and a throw
    // here would take the whole sidebar down on launch.
    localStorage.setItem(expansionKey("/tmp/paper"), "{oops");
    renderNavigator({ mode: "project" });

    await waitFor(() => expect(treeItem("main.tex")).not.toBeNull());
    expect(treeItem("sections/intro.tex")).toBeNull();
  });

  it("keeps a command-clicked multi-selection when the newest file opens, and deletes it as one action", async () => {
    expandSections();
    let rerenderWith: (next: Partial<NavigatorProps>) => void = () => undefined;
    // Opening a file re-renders with it active, the way App does.
    const view = renderNavigator({ mode: "project", onFile: vi.fn((path: string) => rerenderWith({ activeFile: path })) });
    rerenderWith = view.rerenderWith;
    const main = await findTreeItem("main.tex");
    const intro = await findTreeItem("sections/intro.tex");
    fireEvent.click(main);
    fireEvent.click(intro, { metaKey: true });

    await waitFor(() => {
      expect(main).toHaveAttribute("data-item-selected", "true");
      expect(intro).toHaveAttribute("data-item-selected", "true");
    });
    fireEvent.contextMenu(intro);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(view.props.onDeleteEntries).toHaveBeenCalledWith(["main.tex", "sections/intro.tex"]));
  });

  it("copies a project file with Command-C/V instead of reading an image", async () => {
    const { props } = renderNavigator({ mode: "project" });
    const main = await findTreeItem("main.tex");
    fireEvent.click(main);
    fireEvent.keyDown(main, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/paper/main.tex"));
    vi.mocked(readText).mockResolvedValue("/tmp/paper/main.tex");
    const folder = treeItem("sections/")!;
    fireEvent.click(folder);
    fireEvent.keyDown(folder, { key: "v", metaKey: true });
    await waitFor(() => expect(props.onCopyEntries).toHaveBeenCalledWith(["main.tex"], "sections"));
    expect(props.onPasteImage).not.toHaveBeenCalled();

    vi.mocked(readText).mockRejectedValue(new Error("Clipboard has no text"));
    fireEvent.keyDown(folder, { key: "v", metaKey: true });
    await waitFor(() => expect(props.onPasteImage).toHaveBeenCalledWith("sections"));
    expect(props.onCopyEntries).toHaveBeenCalledTimes(1);
  });

  it("copies a folder only once when its child is also selected", async () => {
    expandSections();
    const { props } = renderNavigator({ mode: "project" });
    fireEvent.click(await findTreeItem("sections/intro.tex"));
    fireEvent.click(treeItem("sections/")!, { metaKey: true });
    fireEvent.keyDown(treeItem("sections/")!, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/paper/sections"));
    vi.mocked(readText).mockResolvedValue("/tmp/paper/sections");
    const main = treeItem("main.tex")!;
    fireEvent.click(main);
    fireEvent.keyDown(main, { key: "v", metaKey: true });
    await waitFor(() => expect(props.onCopyEntries).toHaveBeenCalledWith(["sections"], ""));
  });

  it("renames the selected file with Enter and confirms from the rename input", async () => {
    const { props } = renderNavigator({ mode: "project" });
    const main = await findTreeItem("main.tex");
    fireEvent.click(main);
    fireEvent.keyDown(main, { key: "Enter" });
    const input = await waitFor(() => {
      const field = treeRoot()?.querySelector("[data-item-rename-input]");
      expect(field).not.toBeNull();
      return field!;
    });
    expect(input).toHaveValue("main.tex");
    fireEvent.keyDown(input, { key: "c", metaKey: true });
    fireEvent.keyDown(input, { key: "v", metaKey: true });
    expect(writeText).not.toHaveBeenCalled();
    expect(props.onPasteImage).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "renamed.tex" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(props.onRenameEntry).toHaveBeenCalledWith("main.tex", "renamed.tex"));
  });

  it.each([
    ["the directory chosen in the context menu", async (folder: HTMLElement) => {
      fireEvent.contextMenu(folder);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Paste clipboard image as figure" }));
    }],
    ["the selected directory with Command-V", async (folder: HTMLElement) => {
      fireEvent.click(folder);
      fireEvent.keyDown(folder, { key: "v", metaKey: true });
    }],
  ])("pastes a clipboard image into %s", async (_case, paste) => {
    const { props } = renderNavigator({ mode: "project" });
    await paste(await findTreeItem("sections/"));

    await waitFor(() => expect(props.onPasteImage).toHaveBeenCalledWith("sections"));
  });
});
