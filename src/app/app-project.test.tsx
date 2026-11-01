import { expectNotification, windowApi, browserRuntime, fileNode, fileNodes, dirNode, projectCommands, refreshableProject, attentionPaper, ROOT, projectSnapshot, rootDocument, deferred, setAutoBuildMode, setInterfaceLanguage, projectTreeRoot, queryProjectTreeItem, findInProjectTree, findProjectTreeItem, findProjectTreeRenameInput, findElement, expectInvoked, invokeCalls, stubElementFromPoint, storedFileViews, dropFinderPaths, argPath, waitForSelectedTab, openTreeFile, openAgentFrame, postedOfType, dragTreeItem, chooseNewDocument, nextFrames, fileHit, expandDirectories } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { renderApp } = appHarness();

describe("project tree and projects", () => {

  it.each(["fullscreen", "a browser tab"])("marks the shell in %s, where the traffic lights are not beside the titlebar", async (host) => {
    if (host === "fullscreen") windowApi.isFullscreen.mockResolvedValue(true);
    else browserRuntime.hosted = true;
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    await screen.findByRole("button", { name: "Switch project" });
    const shell = () => expect(document.querySelector(".app-shell"));
    if (host === "fullscreen") {
      await waitFor(() => shell().toHaveClass("fullscreen"));
    } else {
      shell().toHaveClass("browser-hosted");
      expect(invoke).not.toHaveBeenCalledWith("align_traffic_lights", expect.anything());
    }
  });

  describe("open in browser", () => {
    const openProject = (commands = {}) => renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), open_in_browser: null, return_to_desktop: null, ...commands,
    });

    it("hands a native window's workspace to the browser, then closes the window", async () => {
      openProject();
      fireEvent.click(await screen.findByRole("button", { name: "Open in browser" }));
      await expectInvoked("open_in_browser");
      // The tab starts relaying only once this window is gone.
      await waitFor(() => expect(windowApi.close).toHaveBeenCalledOnce());
    });

    it("reports a failed handoff and keeps the window", async () => {
      openProject({ open_in_browser: () => { throw new Error("Could not start local browser access"); } });
      fireEvent.click(await screen.findByRole("button", { name: "Open in browser" }));
      await expectNotification(/Could not start local browser access/);
      expect(windowApi.close).not.toHaveBeenCalled();
    });

    it("gives a browser tab's workspace back to the Lattice app, from the title bar or the command palette", async () => {
      browserRuntime.hosted = true;
      openProject();
      fireEvent.click(await screen.findByRole("button", { name: "Open in Lattice app" }));
      await expectInvoked("return_to_desktop");
      expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();

      vi.mocked(invoke).mockClear();
      fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
      fireEvent.change(await screen.findByRole("searchbox", { name: "Command palette" }), { target: { value: "Open in Lattice" } });
      fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette" }), { key: "Enter" });
      await expectInvoked("return_to_desktop");
    });
  });

  it("asks for the system's title-bar action on a double-click of the bar, never full screen, and leaves its controls alone", async () => {
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    fireEvent.doubleClick(await screen.findByRole("button", { name: "Switch project" }));
    expect(invokeCalls("title_bar_double_click")).toHaveLength(0);
    fireEvent.doubleClick(document.querySelector(".titlebar-drag-area")!);
    await expectInvoked("title_bar_double_click");
  });

  it("automatically refreshes the project tree when files appear on disk", async () => {
    const snapshot = projectSnapshot();
    renderApp({ ...projectCommands(snapshot), refresh_project: { ...snapshot, files: [...snapshot.files, fileNode("notes.md")] } });
    expect(queryProjectTreeItem("notes.md")).toBeNull();
    expect(await findProjectTreeItem("notes.md", 3500)).toBeInTheDocument();
  });

  it("uses Pierre's default density, flattened folders, and Git decorations", async () => {
    localStorage.setItem("lattice:show-hidden-files", "true");
    localStorage.setItem("lattice:expanded-directories:/tmp/lattice-paper", JSON.stringify(["chapters", "chapters/method"]));
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("chapters/method/main.tex", "Main paper"),
      files: [
        dirNode("chapters", [dirNode("chapters/method", [fileNode("chapters/method/main.tex")])]),
        fileNode("component.tsx", "text"), fileNode("references.bib", "text"),
        ...fileNodes("paper.pdf", "conference.sty", "plain.bst", "figure.eps"),
      ],
    });
    renderApp({
      ...refreshableProject(snapshot), list_project_tree_with_hidden: () => snapshot.files,
      git_status: () => ({
        available: true, repository: true, branch: "main",
        files: [{ path: "chapters/method/main.tex", status: "modified", staged: false, unstaged: true }],
      }),
    });
    const file = await findProjectTreeItem("chapters/method/main.tex");
    await waitFor(() => expect(file).toHaveAttribute("data-item-git-status", "modified"));

    const host = document.querySelector<HTMLElement>("file-tree-container.lattice-file-tree");
    expect(host?.style.getPropertyValue("--trees-item-height")).toBe("28px");
    expect(host).toHaveAttribute("data-file-tree-virtualized", "true");
    for (const [path, icon] of [
      ["chapters/method/main.tex", "lattice-glyph-tex"], ["references.bib", "lattice-glyph-bib"],
      ["paper.pdf", "lattice-glyph-pdf"], ["conference.sty", "lattice-glyph-style"],
      ["plain.bst", "lattice-glyph-style"], ["figure.eps", "lattice-glyph-image"],
      ["component.tsx", "lattice-glyph-code"],
    ]) expect((await findProjectTreeItem(path)).querySelector("use")).toHaveAttribute("href", `#${icon}`);
    const folderRows = projectTreeRoot()?.querySelectorAll("[data-item-type='folder']");
    expect(new Set(Array.from(folderRows ?? [], (row) => (row as HTMLElement).dataset.itemPath))).toEqual(new Set(["chapters/method/"]));
    for (const trigger of projectTreeRoot()?.querySelectorAll("[data-type='context-menu-trigger']") ?? []) {
      expect(trigger).toHaveAttribute("data-visible", "false");
    }
  });

  it("ignores full-text search results that arrive after a newer query", async () => {
    type Hits = Array<Record<string, unknown>>;
    const [older, newer] = [deferred<Hits>(), deferred<Hits>()];
    renderApp({
      ...refreshableProject(),
      search_project: (args) => ((args as { query?: string } | undefined)?.query === "older" ? older : newer).promise,
    });
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Find in project" });
    fireEvent.change(input, { target: { value: "older" } });
    await expectInvoked("search_project", { query: "older" });
    fireEvent.change(input, { target: { value: "newer" } });
    await expectInvoked("search_project", { query: "newer" });
    await act(async () => {
      newer.resolve([fileHit("newer.tex", 2, "The current result.")]);
      await newer.promise;
    });
    expect(await screen.findByTitle("newer.tex:2")).toBeInTheDocument();
    await act(async () => {
      older.resolve([fileHit("older.tex", 7, "A stale result.")]);
      await older.promise;
    });
    expect(screen.queryByTitle("older.tex:7")).not.toBeInTheDocument();
    expect(screen.getByTitle("newer.tex:2")).toBeInTheDocument();
  });

  it("tracks each pointer row as the drop target and persists the move", async () => {
    expandDirectories("sections");
    const beforeMove = projectSnapshot({
      files: [...fileNodes("main.tex", "draft.tex"), dirNode("figures"), dirNode("notes"), dirNode("sections")],
    });
    const afterMove = {
      ...beforeMove,
      manifest: { ...beforeMove.manifest, rootDocuments: [{ path: "main.tex", name: "Main paper", isDefault: true }] },
      files: [fileNode("main.tex"), dirNode("figures"), dirNode("notes"), dirNode("sections", [fileNode("sections/draft.tex")])],
    };
    let moved = false;
    const move = deferred<string>();
    renderApp({ ...projectCommands(beforeMove), refresh_project: () => moved ? afterMove : beforeMove, move_project_entry: move.promise });
    const source = await findProjectTreeItem("draft.tex");
    const figures = await findProjectTreeItem("figures/");
    const notes = await findProjectTreeItem("notes/");
    const target = await findProjectTreeItem("sections/");
    const backgroundScans = () => vi.mocked(invoke).mock.calls.filter(([command]) => [
      "refresh_project", "list_papers", "list_citations", "list_references", "list_unused_symbols", "list_history",
    ].includes(command));
    const backgroundCallsBeforeMove = backgroundScans().length;
    const dropTarget = (path: string) => queryProjectTreeItem(path);
    const pointer = { pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(source, { button: 0, clientX: 1, clientY: 1, ...pointer });
    fireEvent.pointerMove(figures, { clientX: 20, clientY: 20, ...pointer });
    await waitFor(() => {
      expect(projectTreeRoot()?.host).toHaveAttribute("data-lattice-pointer-drag-active", "true");
      const preview = projectTreeRoot()?.querySelector<HTMLElement>('[data-lattice-pointer-drag-preview="true"]');
      expect(preview).not.toBeNull();
      expect(preview).toHaveAttribute("aria-hidden", "true");
      expect(preview?.style.transform).toContain("translate3d");
      expect(preview?.style.opacity).toBe("0.76");
      expect(dropTarget("figures/")).toHaveAttribute("data-lattice-drop-target", "true");
    });
    fireEvent.pointerMove(notes, { clientX: 20, clientY: 35, ...pointer });
    await waitFor(() => expect(dropTarget("notes/")).toHaveAttribute("data-lattice-drop-target", "true"));
    fireEvent.pointerMove(target, { clientX: 20, clientY: 50, ...pointer });
    await waitFor(() => expect(dropTarget("sections/")).toHaveAttribute("data-lattice-drop-target", "true"));
    expect(dropTarget("figures/")).not.toHaveAttribute("data-lattice-drop-target");
    expect(dropTarget("notes/")).not.toHaveAttribute("data-lattice-drop-target");
    fireEvent.pointerUp(target, { clientX: 20, clientY: 50, ...pointer });

    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
    // Pierre's local model must move immediately, before filesystem persistence finishes.
    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    moved = true;
    move.resolve("sections/draft.tex");
    await waitFor(() => {
      expect(projectTreeRoot()?.host).not.toHaveAttribute("data-lattice-pointer-drag-active");
      expect(projectTreeRoot()?.querySelector('[data-lattice-pointer-drag-preview="true"]')).toBeNull();
    });
    expect(backgroundScans()).toHaveLength(backgroundCallsBeforeMove);
  });

  it("treats a same-directory drop as a no-op", async () => {
    renderApp(refreshableProject(projectSnapshot({ files: [dirNode("notes"), ...fileNodes("main.tex", "references.bib")] })));
    const source = await findProjectTreeItem("main.tex");
    const target = await findProjectTreeItem("references.bib");
    const pointer = { clientX: 20, clientY: 20, pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(source, { ...pointer, button: 0, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(target, pointer);
    expect(queryProjectTreeItem("references.bib")).not.toHaveAttribute("data-lattice-drop-target");
    await act(async () => { fireEvent.pointerUp(queryProjectTreeItem("references.bib")!, pointer); });
    expect(invoke).not.toHaveBeenCalledWith("move_project_entry", expect.anything());
  });

  it("rolls an optimistic tree move back when persistence fails", async () => {
    expandDirectories("sections");
    const move = deferred<string>();
    const snapshot = projectSnapshot({ files: [...fileNodes("main.tex", "draft.tex"), dirNode("sections")] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: move.promise });
    dragTreeItem(await findProjectTreeItem("draft.tex"), await findProjectTreeItem("sections/"));
    expect(await findProjectTreeItem("sections/draft.tex")).toBeInTheDocument();
    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
    move.reject(new Error("Move failed"));
    expect(await findProjectTreeItem("draft.tex")).toBeInTheDocument();
    await waitFor(() => expect(queryProjectTreeItem("sections/draft.tex")).toBeNull());
  });

  it("moves a nested file to the root when it is dropped on a root file", async () => {
    expandDirectories("sections");
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), dirNode("sections", [fileNode("sections/draft.tex")])] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: "draft.tex" });
    const source = await findProjectTreeItem("sections/draft.tex");
    await findProjectTreeItem("main.tex");
    dragTreeItem(source, () => queryProjectTreeItem("main.tex")!);
    await expectInvoked("move_project_entry", { path: "sections/draft.tex", targetDirectory: "", projectRoot: ROOT });
  });

  it("drops onto the exact segment of a flattened directory", async () => {
    const snapshot = projectSnapshot({ files: [...fileNodes("main.tex", "draft.tex"), dirNode("sections", [dirNode("sections/drafts")])] });
    renderApp({ ...refreshableProject(snapshot), move_project_entry: "sections/draft.tex" });
    const source = await findProjectTreeItem("draft.tex");
    dragTreeItem(source, await findInProjectTree('[data-item-flattened-subitem="sections/"]'));
    await expectInvoked("move_project_entry", { path: "draft.tex", targetDirectory: "sections", projectRoot: ROOT });
  });

  it("reveals project files and imported papers in Finder from the context menu", async () => {
    renderApp({ ...projectCommands(), list_papers: () => [attentionPaper()] });
    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));
    fireEvent.contextMenu(await screen.findByTitle("Attention Is All You Need"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Show in Finder" }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("/tmp/lattice-paper/.research/papers/1706.03762/paper.md"));
  });

  it("imports image files into the figures directory", async () => {
    vi.mocked(open).mockResolvedValue(["/tmp/result.png"]);
    renderApp({ ...refreshableProject(projectSnapshot({ files: [dirNode("figures")] })), import_project_assets: () => ["figures/result.png"] });
    fireEvent.contextMenu(await findProjectTreeItem("figures/"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import images here" }));
    await expectInvoked("import_project_assets", { paths: ["/tmp/result.png"], targetDirectory: "figures", projectRoot: ROOT });
  });

  it("relays image and PDF drops on the agent panel into the composer", async () => {
    renderApp({
      ...projectCommands(),
      read_agent_composer_files: () => [
        { name: "plot.png", mimeType: "image/png", bytesBase64: btoa("png-bytes") },
        { name: "notes.md", mimeType: "text/markdown", bytesBase64: btoa("# Notes") },
      ],
    });
    const { frame, postMessage } = await openAgentFrame({ ready: true });
    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    stubElementFromPoint(frame);
    // A mixed figure + text-source drop: both are agent-readable, so the
    // panel takes precedence over the project source/mixed branches.
    await dropFinderPaths(["/tmp/plot.png", "/tmp/notes.md"]);

    await expectInvoked("read_agent_composer_files", { paths: ["/tmp/plot.png", "/tmp/notes.md"] });
    type ComposerFiles = { version?: number; files?: { name: string; mimeType: string; bytes: ArrayBuffer }[] };
    const message = await waitFor(() => {
      const [posted] = postedOfType<ComposerFiles>(postMessage, "lattice:composer-files");
      expect(posted).toBeDefined();
      return posted;
    });
    expect(message.version).toBe(1);
    expect(message.files?.map(({ name, mimeType, bytes }) => [name, mimeType, new TextDecoder().decode(bytes)])).toEqual([
      ["plot.png", "image/png", "png-bytes"], ["notes.md", "text/markdown", "# Notes"],
    ]);
    expect(invoke).not.toHaveBeenCalledWith("import_project_assets", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("import_project_sources", expect.anything());
  });

  it("duplicates a project file with Command-C/V and shows the new tree entry", async () => {
    const snapshot = projectSnapshot();
    vi.mocked(readText).mockResolvedValue("/tmp/lattice-paper/main.tex");
    renderApp({
      ...projectCommands(null), initial_project: () => structuredClone(snapshot), refresh_project: () => structuredClone(snapshot),
      import_project_files: () => {
        snapshot.files.push(fileNode("main-2.tex"));
        return { conflicts: [], files: [{ path: "main-2.tex", kind: "text" }], entries: ["main-2.tex"], skipped: [] };
      },
    });
    fireEvent.click(await findProjectTreeItem("main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "v", metaKey: true });
    await expectInvoked("import_project_files", {
      paths: ["/tmp/lattice-paper/main.tex"], targetDirectory: "", projectRoot: ROOT, copyExisting: true, conflict: "keepBoth",
    });
    expect(await findProjectTreeItem("main-2.tex")).toBeInTheDocument();
    expect(queryProjectTreeItem("main.tex")).not.toBeNull();
  });

  it.each<[string, string, string[], Array<{ path: string; kind: string }>]>([
    [
      "imports a Finder image into the folder of the file it is dropped on", "sections",
      ["/tmp/plot.png"], [{ path: "sections/plot.png", kind: "binary" }],
    ],
    [
      // Markdown + a data file the old classifier rejected + an image + a
      // folder, all in one drop: the tree takes any mix.
      "imports a mixed Finder file and folder drop where it lands without opening files", "sections",
      ["/tmp/notes.md", "/tmp/data.csv", "/tmp/plot.png", "/tmp/tables"],
      [
        { path: "sections/notes.md", kind: "text" }, { path: "sections/data.csv", kind: "text" },
        { path: "sections/plot.png", kind: "binary" }, { path: "sections/tables/results.csv", kind: "text" },
      ],
    ],
    [
      "imports a Finder image dropped on the Project pane background into the project root", "",
      ["/tmp/plot.png"], [{ path: "plot.png", kind: "binary" }],
    ],
  ])("%s", async (_name, targetDirectory, paths, imported) => {
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), dirNode("sections", [fileNode("sections/intro.tex")])] });
    renderApp({
      ...refreshableProject(snapshot),
      import_project_files: () => ({ conflicts: [], files: imported, entries: imported.map((file) => file.path), skipped: [] }),
    });
    if (targetDirectory) {
      fireEvent.click(await findProjectTreeItem("sections/"));
      stubElementFromPoint(await findProjectTreeItem("sections/intro.tex"));
    } else {
      await findProjectTreeItem("main.tex");
      stubElementFromPoint(await findElement(".project-section"));
    }
    await dropFinderPaths(paths);

    await expectInvoked("import_project_files", { paths, targetDirectory, projectRoot: ROOT });
    // Filing into the tree does not open the file; editor drops do that.
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "sections/notes.md" }));
  });

  it("deletes a history entry without creating another one", async () => {
    let entries = [{ id: "change-1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z", files: ["main.tex"] }];
    renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), list_history: () => entries,
      get_history_entry: () => ({
        id: "change-1", label: "Edit main.tex", timestamp: "2026-07-16T00:00:00Z",
        changes: [{ path: "main.tex", before: "old line\n", after: "new line\n" }],
      }),
      delete_history_entry: () => { entries = []; },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Project history" }));
    // HistoryDrawer is lazy-loaded, so wait for its chunk to resolve.
    fireEvent.click(await screen.findByRole("button", { name: "Activity" }, { timeout: 15_000 }));
    fireEvent.click(await screen.findByRole("button", { name: /Edit main\.tex/i }));
    await screen.findByLabelText("Diff for main.tex");
    fireEvent.click(await screen.findByTitle("Delete this history entry"));
    await waitFor(() => expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("delete_history_entry", { transactionId: "change-1" });
  });

  it("localizes the project-file deletion confirmation", async () => {
    await setInterfaceLanguage("zh-CN");
    await import("../project/project-file-tree");
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), fileNode("notes.tex", "text", { contentKind: "text" })] });
    renderApp(refreshableProject(snapshot), { confirmations: true });
    fireEvent.contextMenu(await findProjectTreeItem("notes.tex", 5_000));
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("删除“notes.tex”？");
    expect(dialog).toHaveAccessibleDescription("删除后无法恢复");
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("localizes the imported-paper removal confirmation", async () => {
    await setInterfaceLanguage("zh-CN");
    setAutoBuildMode("manual");
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    let cited = false;
    renderApp({
      ...refreshableProject(), list_papers: () => [paper],
      remove_reference: () => ({
        key: paper.citationKey, removed: false, changedFiles: [], removedCitations: 0,
        blockers: cited ? [{ kind: "citation", symbol: paper.citationKey, role: "reference", path: "main.tex", line: 7 }] : [],
      }),
    }, { confirmations: true });
    fireEvent.click(await screen.findByRole("tab", { name: "论文库" }));
    fireEvent.click(await screen.findByTitle("移除 Attention Is All You Need"));

    const dialogName = "从文献中删除“Attention Is All You Need”？";
    const dialog = await screen.findByRole("dialog", { name: dialogName });
    expect(dialog).toHaveAccessibleDescription("已下载的论文会保留");
    expect(screen.getByRole("button", { name: "删除文献" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    cited = true;
    fireEvent.click(await screen.findByTitle("移除 Attention Is All You Need"));
    expect(await screen.findByRole("dialog", { name: dialogName })).toHaveAccessibleDescription(
      "这条文献被引用了 1 次 第一处：main.tex:7 保留后，这些引用会显示为“？” 已下载的论文会保留",
    );
    expect(screen.getByRole("button", { name: "引用也删" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保留引用" })).toBeInTheDocument();
  });

  it("creates and deletes project entries and imported papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      ROOT: { "notes.tex": { text: { cursor: 8, scrollTop: 40 } } },
    }));
    const snapshot = projectSnapshot({
      rootDocuments: [
        { path: "main.tex", name: "Main paper", isDefault: true },
        // Building a standalone draft registers it here, but does not make it protected.
        { path: "notes.tex", name: "Notes", isDefault: false },
      ],
      files: fileNodes("main.tex", "notes.tex"),
    });

    await import("../project/project-file-tree");
    renderApp({
      ...refreshableProject(snapshot, "\\section{Notes}"),
      list_papers: () => [attentionPaper({ citationKey: "vaswani2017attention" })],
      create_project_entry: (args) => {
        const entry = args as { path: string; kind: "file" | "folder" };
        return entry.kind === "file" && !entry.path.includes(".") ? `${entry.path}.tex` : entry.path;
      },
      delete_project_entry: undefined, remove_reference: () => ({ removed: true, blockers: [] }),
    });
    const projectTreeSurface = await screen.findByLabelText("Project files");
    /** Starts a new tree entry from the project context menu and returns its name input. */
    const startNewEntry = async (menuItem: "New file" | "New folder") => {
      fireEvent.contextMenu(projectTreeSurface);
      fireEvent.click(await screen.findByRole("menuitem", { name: menuItem }));
      const nameInput = await findProjectTreeRenameInput();
      expect(nameInput).toHaveValue("untitled");
      return nameInput;
    };
    const fileNameInput = await startNewEntry("New file");
    fireEvent.input(fileNameInput, { target: { value: "method" } });
    fireEvent.keyDown(fileNameInput, { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "method", kind: "file", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /method\.tex/ })).toBeInTheDocument();

    const folderNameInput = await startNewEntry("New folder");
    fireEvent.input(folderNameInput, { target: { value: "draft" } });
    fireEvent.keyDown(folderNameInput, { key: "Escape" });
    await waitFor(() => expect(projectTreeRoot()?.querySelector("[data-item-rename-input]")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "draft", kind: "folder" });
    expect(queryProjectTreeItem("draft/")).toBeNull();

    fireEvent.blur(await startNewEntry("New folder"));
    await waitFor(() => expect(queryProjectTreeItem("untitled/")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("create_project_entry", { path: "untitled", kind: "folder" });

    fireEvent.keyDown(await startNewEntry("New file"), { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "untitled", kind: "file", projectRoot: ROOT });
    expect(await findProjectTreeItem("untitled.tex")).toBeInTheDocument();

    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();

    await openTreeFile("notes.tex");
    fireEvent.contextMenu(await findProjectTreeItem("notes.tex"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await expectInvoked("delete_project_entry", { path: "notes.tex", projectRoot: ROOT });
    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /notes\.tex/ })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => expect(storedFileViews()[ROOT]?.["notes.tex"]).toBeUndefined());
    fireEvent.click(await screen.findByTitle("Remove Attention Is All You Need"));
    await expectInvoked("remove_reference", { key: "vaswani2017attention", projectRoot: ROOT });
  });

  it("creates writing files beside the selection from the + menu", async () => {
    const created: string[] = [];
    const snapshot = () => projectSnapshot({
      files: [dirNode("chapters", fileNodes("chapters/intro.tex", ...created)), fileNode("main.tex")],
    });
    renderApp({
      ...refreshableProject(snapshot(), ""),
      refresh_project: () => snapshot(),
      create_project_entry: (args) => {
        created.push(argPath(args));
        return argPath(args);
      },
    });
    await waitForSelectedTab("main.tex");
    fireEvent.click(await findProjectTreeItem("chapters/"));
    await nextFrames(2);

    await chooseNewDocument("New LaTeX file");
    const texName = await findProjectTreeRenameInput();
    // The draft wears its extension; only the name before it is selected.
    expect(texName.closest("[data-item-path]")).toHaveAttribute("data-item-path", "chapters/untitled.tex");
    expect(texName).toHaveValue("untitled.tex");
    await waitFor(() => expect([texName.selectionStart, texName.selectionEnd]).toEqual([0, "untitled".length]));
    fireEvent.input(texName, { target: { value: "methods" } });
    fireEvent.keyDown(texName, { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "chapters/methods.tex", kind: "file", projectRoot: ROOT });
    await waitForSelectedTab("chapters/methods.tex");

    // Beside a selected file, in its folder; a canceled name writes nothing.
    await chooseNewDocument("New Markdown file");
    const markdownName = await findProjectTreeRenameInput();
    expect(markdownName.closest("[data-item-path]")).toHaveAttribute("data-item-path", "chapters/untitled.md");
    fireEvent.keyDown(markdownName, { key: "Escape" });
    await waitFor(() => expect(projectTreeRoot()?.querySelector("[data-item-rename-input]")).toBeFalsy());
    expect(invokeCalls("create_project_entry")).toHaveLength(1);
  });

  // The draft's name carries its extension, so it steps past a file that
  // already holds it rather than creating that file a second time.
  it("names a + menu draft past an existing untitled file", async () => {
    renderApp({
      ...refreshableProject(projectSnapshot({
        files: [dirNode("chapters", fileNodes("chapters/untitled.tex")), fileNode("main.tex")],
      }), ""),
      create_project_entry: (args) => argPath(args),
    });
    await waitForSelectedTab("main.tex");
    fireEvent.click(await findProjectTreeItem("chapters/"));
    await nextFrames(2);

    await chooseNewDocument("New LaTeX file");
    const name = await findProjectTreeRenameInput();
    expect(name.closest("[data-item-path]")).toHaveAttribute("data-item-path", "chapters/untitled-2.tex");
    expect(name).toHaveValue("untitled-2.tex");
    await waitFor(() => expect([name.selectionStart, name.selectionEnd]).toEqual([0, "untitled-2".length]));
    fireEvent.keyDown(name, { key: "Enter" });
    await expectInvoked("create_project_entry", { path: "chapters/untitled-2.tex", kind: "file", projectRoot: ROOT });
  });
});
