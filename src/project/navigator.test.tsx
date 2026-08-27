import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode, PaperSummary } from "../app-types";
import { Navigator } from "./navigator";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
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
      fireEvent.change(screen.getByRole("searchbox", { name: "Search or import papers" }), {
        target: { value: query },
      });
      rerenderWith({ importInput: query });
    },
  };
}

function paperTitles() {
  return Array.from(document.querySelectorAll(".paper-row .paper-open"))
    .map((button) => button.querySelector("strong")?.textContent ?? "");
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
});

describe("Navigator / papers", () => {
  it("lists the whole library until something is typed", () => {
    renderNavigator();

    expect(paperTitles()).toEqual(["Attention Is All You Need", "An Image Is Worth 16x16 Words"]);
    expect(screen.getByText("2 papers")).toBeInTheDocument();
  });

  it("narrows on every word, not just the first", () => {
    // Each token has to match somewhere in the entry, so a second word can only
    // ever shorten the list — that is what makes typing feel like searching.
    const { search } = renderNavigator();

    search("image");
    expect(paperTitles()).toEqual(["An Image Is Worth 16x16 Words"]);

    search("image vaswani");
    expect(paperTitles()).toEqual([]);
    expect(screen.getByText("No matching papers")).toBeInTheDocument();
  });

  it("searches metadata the row never shows", () => {
    const { search } = renderNavigator();

    search("dosovitskiy");
    expect(paperTitles()).toEqual(["An Image Is Worth 16x16 Words"]);

    search("vaswani2017");
    expect(paperTitles()).toEqual(["Attention Is All You Need"]);
  });

  it("finds a paper from a pasted arXiv URL or a versioned id", () => {
    // Pasting a link is how a paper is imported, so the same paste has to find
    // the copy already in the library instead of offering to fetch it again.
    const { search } = renderNavigator();

    search("https://arxiv.org/abs/2010.11929v3");
    expect(paperTitles()).toEqual(["An Image Is Worth 16x16 Words"]);
    expect(screen.getByText("1 of 2 papers")).toBeInTheDocument();
  });

  it("opens the top match on Enter, and imports when there is none", () => {
    const { props, search } = renderNavigator();
    const searchbox = () => screen.getByRole("searchbox", { name: "Search or import papers" });

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

  it("adds papers whose text matched even when their metadata did not", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockResolvedValue([
        { arxivId: "1706.03762", title: "Attention Is All You Need", snippet: "  scaled dot-product  " },
      ]);
      const { search } = renderNavigator();

      search("dot-product");
      expect(paperTitles()).toEqual([]);

      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      expect(invoke).toHaveBeenCalledWith("search_paper_library", { query: "dot-product" });
      expect(paperTitles()).toEqual(["Attention Is All You Need"]);
      // The matching line replaces the usual subtitle, so the hit is visible.
      expect(screen.getByText("scaled dot-product")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps filtering by metadata when the full-text index cannot be read", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockRejectedValue(new Error("index missing"));
      const { search } = renderNavigator();

      search("attention");
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      expect(paperTitles()).toEqual(["Attention Is All You Need"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a pause in typing before asking the backend", async () => {
    vi.useFakeTimers();
    try {
      const { search } = renderNavigator();

      search("a");
      search("at");
      search("att");
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });

      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith("search_paper_library", { query: "att" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the library is empty rather than showing nothing at all", () => {
    renderNavigator({ papers: [] });

    expect(screen.getByText("Add your first paper")).toBeInTheDocument();
    expect(screen.queryByText("No matching papers")).toBeNull();
  });
});

describe("Navigator / project tree", () => {
  const expansionKey = (projectKey: string) => `lattice:expanded-directories:${projectKey}`;

  function treeRoot(): ShadowRoot | null {
    return document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot ?? null;
  }

  function treeItem(path: string): HTMLElement | null {
    return Array.from(treeRoot()?.querySelectorAll<HTMLElement>("[data-item-path]") ?? [])
      .find((item) => item.dataset.itemPath === path) ?? null;
  }

  it("reopens the folders the last session left open", async () => {
    // Stored without Pierre's trailing slash, which is the form the tree wants
    // back — a mismatch here silently collapses everyone's tree on restart.
    localStorage.setItem(expansionKey("/tmp/paper"), JSON.stringify(["sections"]));
    renderNavigator({ mode: "project" });

    await waitFor(() => expect(treeItem("sections/intro.tex")).not.toBeNull());
  });

  it("keeps each project's folders to itself", async () => {
    localStorage.setItem(expansionKey("/tmp/paper"), JSON.stringify(["sections"]));
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

  it("keeps a command-clicked multi-selection when the newest file opens", async () => {
    localStorage.setItem(expansionKey("/tmp/paper"), JSON.stringify(["sections"]));
    let rerenderWith: (next: Partial<NavigatorProps>) => void = () => undefined;
    const onFile = vi.fn((path: string) => rerenderWith({ activeFile: path }));
    ({ rerenderWith } = renderNavigator({ mode: "project", onFile }));
    const main = await waitFor(() => {
      const item = treeItem("main.tex");
      expect(item).not.toBeNull();
      return item!;
    });
    const intro = await waitFor(() => {
      const item = treeItem("sections/intro.tex");
      expect(item).not.toBeNull();
      return item!;
    });

    fireEvent.click(main);
    fireEvent.click(intro, { metaKey: true });

    await waitFor(() => {
      expect(main).toHaveAttribute("data-item-selected", "true");
      expect(intro).toHaveAttribute("data-item-selected", "true");
    });
  });

  it("deletes the selected files as one action", async () => {
    localStorage.setItem(expansionKey("/tmp/paper"), JSON.stringify(["sections"]));
    let rerenderWith: (next: Partial<NavigatorProps>) => void = () => undefined;
    const onFile = vi.fn((path: string) => rerenderWith({ activeFile: path }));
    const onDeleteEntries = vi.fn();
    ({ rerenderWith } = renderNavigator({ mode: "project", onFile, onDeleteEntries }));
    const main = await waitFor(() => {
      const item = treeItem("main.tex");
      expect(item).not.toBeNull();
      return item!;
    });
    const intro = await waitFor(() => {
      const item = treeItem("sections/intro.tex");
      expect(item).not.toBeNull();
      return item!;
    });
    fireEvent.click(main);
    fireEvent.click(intro, { metaKey: true });

    fireEvent.contextMenu(intro);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(onDeleteEntries).toHaveBeenCalledWith([
      "main.tex",
      "sections/intro.tex",
    ]));
  });

  it("pastes a clipboard image into the directory chosen in the context menu", async () => {
    const onPasteImage = vi.fn();
    renderNavigator({ mode: "project", onPasteImage });
    const folder = await waitFor(() => {
      const item = treeItem("sections/");
      expect(item).not.toBeNull();
      return item!;
    });

    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByRole("menuitem", {
      name: "Paste clipboard image as figure",
    }));

    await waitFor(() => expect(onPasteImage).toHaveBeenCalledWith("sections"));
  });

  it("pastes a clipboard image into the selected directory with Command-V", async () => {
    const onPasteImage = vi.fn();
    renderNavigator({ mode: "project", onPasteImage });
    const folder = await waitFor(() => {
      const item = treeItem("sections/");
      expect(item).not.toBeNull();
      return item!;
    });

    fireEvent.click(folder);
    fireEvent.keyDown(folder, { key: "v", metaKey: true });

    expect(onPasteImage).toHaveBeenCalledWith("sections");
  });
});
