import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { FileNode } from "../app-types";
import { ProjectFileTree } from "./project-file-tree";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

type ProjectFileTreeProps = ComponentProps<typeof ProjectFileTree>;

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

function baseProps(): ProjectFileTreeProps {
  return {
    projectKey: "/tmp/paper",
    searchOpen: false,
    newEntryRequest: null,
    onSearchOpenChange: vi.fn(),
    files,
    gitStatus: [],
    activeFile: "main.tex",
    activeAssetPath: "",
    protectedPaths: [],
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
  };
}

function renderTree(overrides?: Partial<ProjectFileTreeProps>) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<ProjectFileTree key={props.projectKey} {...props} />);
  const rerenderWith = (next: Partial<ProjectFileTreeProps>) => {
    Object.assign(props, next);
    view.rerender(<ProjectFileTree key={props.projectKey} {...props} />);
  };
  return { ...view, props, rerenderWith };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
  vi.mocked(writeText).mockReset().mockResolvedValue();
  vi.mocked(readText).mockReset().mockResolvedValue("");
});

describe("ProjectFileTree", () => {
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
    const view = renderTree({ files: [...files, ...["journal.sty", "refs.BST", "journal.sty.tex"].map(textFile)] });
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
    renderTree();
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
    const { rerenderWith } = renderTree();
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
    const { rerenderWith } = renderTree();
    await waitFor(() => expect(treeItem("sections/intro.tex")).not.toBeNull());

    rerenderWith({ projectKey: "/tmp/other" });

    await waitFor(() => expect(treeItem("sections/intro.tex")).toBeNull());
    expect(treeItem("sections/")).not.toBeNull();
  });

  it("survives expansion state that is not a list of paths", async () => {
    // The key is plain JSON in localStorage: anything can be in it, and a throw
    // here would take the whole sidebar down on launch.
    localStorage.setItem(expansionKey("/tmp/paper"), "{oops");
    renderTree();

    await waitFor(() => expect(treeItem("main.tex")).not.toBeNull());
    expect(treeItem("sections/intro.tex")).toBeNull();
  });

  it("keeps a command-clicked multi-selection when the newest file opens, and deletes it as one action", async () => {
    expandSections();
    let rerenderWith: (next: Partial<ProjectFileTreeProps>) => void = () => undefined;
    // Opening a file re-renders with it active, the way App does.
    const view = renderTree({ onFile: vi.fn((path: string) => rerenderWith({ activeFile: path })) });
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

  it("keeps a pressed row from scrolling itself into view, so a row cut off at the edge still opens", async () => {
    expandSections();
    const view = renderTree();
    const intro = await findTreeItem("sections/intro.tex");
    // The native focus scroll would recycle the virtualized rows between
    // mousedown and mouseup and send the click to the list instead.
    expect(fireEvent.mouseDown(intro, { button: 0 })).toBe(false);
    expect(fireEvent.mouseDown(intro, { button: 2 })).toBe(true);
    fireEvent.click(intro);
    await waitFor(() => expect(view.props.onFile).toHaveBeenCalledWith("sections/intro.tex"));
  });

  it("keeps the drag ghost under the pointer when the interface scale zooms the page", async () => {
    // The browser-hosted app sets the interface scale as CSS `zoom` on the
    // root: rows and the pointer report zoomed client pixels, and the ghost
    // renders every pixel length it is given multiplied by the zoom again.
    const zoom = 1.25;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.latticePointerDragPreview) {
        const width = Number.parseFloat(this.style.width) * zoom;
        const height = Number.parseFloat(this.style.height) * zoom;
        return DOMRect.fromRect({ x: 0, y: 0, width, height });
      }
      if (this.dataset.itemPath === "main.tex") return DOMRect.fromRect({ x: 20, y: 100, width: 250, height: 40 });
      return DOMRect.fromRect();
    });
    renderTree();
    const main = await findTreeItem("main.tex");
    const pointer = { pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(main, { ...pointer, button: 0, clientX: 60, clientY: 120 });
    fireEvent.pointerMove(main, { ...pointer, clientX: 60, clientY: 300 });

    const preview = await waitFor(() => {
      const ghost = treeRoot()?.querySelector<HTMLElement>('[data-lattice-pointer-drag-preview="true"]');
      expect(ghost?.style.transform).toContain("translate3d");
      return ghost!;
    });
    // Grabbed 40px right of and 20px below the row's corner, the ghost's
    // corner must render at (60 - 40, 300 - 20) client pixels: 16px and 224px
    // in the zoomed CSS pixels the transform is written in, not 20px and 280px.
    expect(preview.style.transform).toBe("translate3d(16px, 224px, 0) scale(1)");
    expect(preview.style.width).toBe("200px");
    expect(preview.style.height).toBe("32px");
    fireEvent.pointerUp(main, { ...pointer, clientX: 60, clientY: 300 });
  });

  it("copies a project file with Command-C/V instead of reading an image", async () => {
    const { props } = renderTree();
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
    const { props } = renderTree();
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
    const { props } = renderTree();
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
    const { props } = renderTree();
    await paste(await findTreeItem("sections/"));

    await waitFor(() => expect(props.onPasteImage).toHaveBeenCalledWith("sections"));
  });
});

