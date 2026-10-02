import { tauriEventApi, fileNode, fileNodes, dirNode, type CommandResult, projectCommands, refreshableProject, attentionPaper, ROOT, projectSnapshot, rootDocument, markdownSnapshot, EMPTY_BOARD, BIB_SOURCE, PAPER_ABSTRACT, readFiles, readPathContent, deferred, selectPanelTab, selectDocumentView, findProjectTreeItem, renderApp, exposeGarbageCollector, expectNotification, emitTauriEvent, editorViewAt, appendToEditor, expectEditorText, postWindowMessage, expectInvoked, invokeCalls, pause, nextFrames, stubRect, persistLayout, paneContent, visualEditorOf, visualDocument, argPath, waitForSelectedTab, openTreeFile, stubScrollBox, chooseProjectMenuItem } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceLayout } from "../settings/app-settings";
import { loadTextLanguageExtensions } from "../editor/editor-languages";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";

describe("documents and editors", () => {
  it.each([
    ["scripts/train.py", "def train(steps):\n    return steps + 1", "FunctionDefinition"],
    ["config/settings.toml", "[tool]\nname = \"research-writer\"\nenabled = true", "propertyName"],
    [".gitignore", "# Build output\ndist/\n*.log\n!important.log", "comment"],
  ])("loads syntax highlighting for %s", async (path, source, expectedNode) => {
    const state = EditorState.create({ doc: source, extensions: await loadTextLanguageExtensions(path) });
    expect(syntaxTree(state).toString()).toContain(expectedNode);
  });

  it("hands a re-opened file the language it already resolved", async () => {
    // Opening a file whose language loads asynchronously used to mount the editor bare and reconfigure it once the
    // language arrived, which parses the document a second time on every visit. Resolving to the same array for a
    // second file of the same type is what lets the editor be created with its language instead.
    for (const [first, second] of [["notes.md", "chapters/intro.md"], ["scripts/train.py", "tools/eval.py"]]) {
      const initial = await loadTextLanguageExtensions(first);
      expect(initial.length).toBeGreaterThan(0);
      expect(await loadTextLanguageExtensions(second)).toBe(initial);
      expect(await loadTextLanguageExtensions(first)).toBe(initial);
    }
  });

  it("temporarily reveals auxiliary sources without forgetting the selected document view", async () => {
    localStorage.setItem("lattice:show-hidden-files", "true");
    const snapshot = markdownSnapshot("notes.md", fileNodes("notes.md", "references.bib", "conference.sty"));
    renderApp({
      ...projectCommands(snapshot), list_project_tree_with_hidden: () => snapshot.files,
      read_project_file: readFiles({ "references.bib": BIB_SOURCE, "conference.sty": "\\ProvidesPackage{conference}" }, "# Notes"),
    });
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Preview");
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    // An auxiliary source opens in the plain source editor, with no document views.
    const expectPlainSource = async () => {
      await waitFor(() => expect(document.querySelector(".source-editor")).not.toBeNull());
      expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    };
    await openTreeFile("references.bib");
    await expectPlainSource();

    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(document.querySelector(".source-editor")).toBeNull());

    selectDocumentView("Split");
    await openTreeFile("conference.sty");
    await expectPlainSource();

    fireEvent.click(await findProjectTreeItem("notes.md"));
    expect(await screen.findByRole("separator", { name: "Resize editor and Markdown preview" })).toBeInTheDocument();
  });

  it.each([
    ["PDF asset", "reference.pdf", "read_project_asset"],
    ["paper", ".research/papers/1706.03762/paper.md", "read_paper"],
  ])("keeps a file opened during slow restore loads over the restored %s tab", async (_kind, restoredTab, reader) => {
    // Regression: restore awaited history, comments, todos and word count
    // after its last freshness check, then queued the restored surface anyway;
    // it opened with a newer load generation and dropped the writer's file.
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "notes.md", "reference.pdf") });
    persistLayout(snapshot.root, {
      openTabs: ["main.tex", "notes.md", restoredTab], activeFile: "main.tex", activeTab: restoredTab, canvasMode: "split",
    });
    const wordCount = deferred<null>();
    const notesRead = deferred<string>();
    renderApp({
      ...projectCommands(snapshot), list_papers: () => [attentionPaper()],
      read_project_file: (args) => argPath(args) === "notes.md" ? notesRead.promise : readPathContent(args),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "application/pdf", base64: "JVBERi0xLjQ=" }),
      read_paper: PAPER_ABSTRACT, read_paper_blog_local: null, count_project_words: () => wordCount.promise,
    });
    await waitFor(() => expect(invokeCalls("count_project_words")).toHaveLength(1));
    fireEvent.click(await findProjectTreeItem("notes.md"));
    await waitFor(() => expect(invokeCalls("read_project_file", (args) => argPath(args) === "notes.md")).toHaveLength(1));
    await act(async () => {
      wordCount.resolve(null);
      await nextFrames(3);
    });
    await act(async () => {
      notesRead.resolve("content:notes.md");
      await nextFrames(3);
    });
    await waitForSelectedTab("notes.md");
    expect(paneContent("primary")).toHaveTextContent("content:notes.md");
    expect(invokeCalls(reader)).toHaveLength(0);
  });

  it("releases the previous source editor after switching files", async () => {
    // Regression: DocumentCanvas closures capture their whole render scope and
    // CodeMirror keeps its extensions' closures alive, so an editor view held
    // strongly in that scope chained every replaced editor (and its document)
    // to its successor for the rest of the session.
    const collectGarbage = exposeGarbageCollector();
    const snapshot = projectSnapshot({ rootDocuments: [], files: fileNodes("a.txt", "b.txt", "c.txt") });
    persistLayout(snapshot.root, { openTabs: ["a.txt", "b.txt", "c.txt"], activeFile: "a.txt", canvasMode: "source" });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:a.txt"));
    const firstView = new WeakRef(EditorView.findFromDOM(paneContent("primary")!)!);
    for (const path of ["b.txt", "c.txt", "b.txt", "c.txt"]) {
      fireEvent.click(await screen.findByRole("tab", { name: path }));
      await waitFor(() => expect(paneContent("primary")).toHaveTextContent(`content:${path}`));
    }
    await waitFor(async () => {
      await collectGarbage();
      expect(firstView.deref()).toBeUndefined();
    }, { timeout: 5_000 });
  });

  it.each(["close button", "middle click"])("closes a background tab by its %s without opening it", async (gesture) => {
    // Regression: the workspace's tab-click listener activated the clicked tab's document even when the click
    // landed on its close button, so the deferred activation reopened the file the close had just removed.
    const snapshot = projectSnapshot({ rootDocuments: [], files: fileNodes("a.txt", "b.txt", "c.txt") });
    persistLayout(snapshot.root, { openTabs: ["a.txt", "b.txt", "c.txt"], activeFile: "a.txt", canvasMode: "source" });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:a.txt"));
    const tab = await screen.findByRole("tab", { name: "b.txt" });
    if (gesture === "close button") {
      const close = tab.querySelector<HTMLElement>("[data-trellis-part=tab-close]")!;
      fireEvent.pointerDown(close, { button: 0 });
      fireEvent.click(close, { button: 0 });
    } else {
      fireEvent.pointerDown(tab, { button: 1 });
      fireEvent(tab, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    }
    await waitFor(() => expect(screen.queryByRole("tab", { name: "b.txt" })).toBeNull());
    await nextFrames(3);
    await pause(50);
    expect(screen.getAllByRole("tab", { name: /\.txt$/ }).map((item) => item.textContent)).toEqual(["a.txt", "c.txt"]);
    await waitForSelectedTab("a.txt");
    expect(paneContent("primary")).toHaveTextContent("content:a.txt");
    expect(invokeCalls("read_project_file", (args) => argPath(args) === "b.txt")).toHaveLength(0);
  });

  it("reopens a closed figure tab with Command-Shift-T through the asset reader", async () => {
    // Regression: reopening went through the text-file loader, so a PDF or
    // image tab came back as a "No such text file" error instead of the figure.
    const snapshot = projectSnapshot({ rootDocuments: [], files: fileNodes("a.txt", "plot.png") });
    persistLayout(snapshot.root, { openTabs: ["a.txt", "plot.png"], activeFile: "a.txt", canvasMode: "source" });
    renderApp({
      ...projectCommands(snapshot),
      read_project_file: readPathContent,
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/png", base64: "iVBORw0KGgo=" }),
    });
    fireEvent.click(await screen.findByRole("tab", { name: "plot.png" }));
    await waitForSelectedTab("plot.png");
    const close = screen.getByRole("tab", { name: "plot.png" }).querySelector<HTMLElement>("[data-trellis-part=tab-close]")!;
    fireEvent.pointerDown(close, { button: 0 });
    fireEvent.click(close, { button: 0 });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "plot.png" })).toBeNull());
    const assetReads = invokeCalls("read_project_asset").length;

    fireEvent.keyDown(window, { key: "t", metaKey: true, shiftKey: true });
    await waitForSelectedTab("plot.png");
    await waitFor(() => expect(invokeCalls("read_project_asset").length).toBeGreaterThan(assetReads));
    expect(invokeCalls("read_project_file", (args) => argPath(args) === "plot.png")).toHaveLength(0);
  });

  it("lists sections from included chapters in Go to symbol without the outline open", async () => {
    // Regression: the included files were only read while the Outline panel
    // was open, so ⌘⇧O found nothing in a book whose sections live in chapters.
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), dirNode("chapters", fileNodes("chapters/intro.tex"))] });
    const chapter = deferred<string>();
    renderApp({
      ...projectCommands(snapshot),
      read_project_file: (args) => argPath(args) === "chapters/intro.tex"
        ? chapter.promise
        : "\\documentclass{book}\n\\begin{document}\n\\include{chapters/intro}\n\\end{document}",
    });
    await waitForSelectedTab("main.tex");
    fireEvent.keyDown(window, { key: "o", metaKey: true, shiftKey: true });
    const search = await screen.findByRole("searchbox", { name: "Go to symbol" });
    // What the writer types before the chapters arrive survives their arrival.
    fireEvent.change(search, { target: { value: "moti" } });
    await act(async () => chapter.resolve("\\chapter{Introduction}\n\\section{Motivation}"));
    const dialog = screen.getByRole("dialog", { name: "Go to symbol" });
    expect(await within(dialog).findByText("Motivation")).toBeInTheDocument();
    expect(within(dialog).getByText("chapters/intro.tex:2")).toBeInTheDocument();
    expect(within(dialog).queryByText("Introduction")).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Go to symbol" })).toHaveValue("moti");
  });

  it("restores tab order and the editor while migrating the old three-column layout", async () => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "intro.tex", "method.tex") });
    persistLayout(snapshot.root, {
      openTabs: ["intro.tex", "main.tex", "method.tex"], activeFile: "main.tex", activeTab: "method.tex",
      // The retired three-column mode, as an older build saved it.
      canvasMode: "columns" as WorkspaceLayout["canvasMode"],
      ...{ secondaryFile: "method.tex", focusedPane: "secondary" } as unknown as Partial<WorkspaceLayout>,
      tabRecency: ["method.tex", "main.tex", "intro.tex"],
    });
    renderApp({ ...projectCommands(snapshot), read_project_file: readPathContent });
    // There is no second editor any more: the old layout's primary file opens as the editor, and the file its
    // right-hand pane held stays an open tab.
    await waitFor(() => expect(paneContent("primary")).toHaveTextContent("content:main.tex"));
    expect(paneContent("secondary")).toBeNull();
    await waitFor(() => expect(screen.getAllByRole("tab", { name: /\.tex$/ }).map((tab) => tab.textContent))
      .toEqual(["intro.tex", "main.tex", "method.tex"]));
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "main.tex", projectRoot: ROOT });
  });

  it.each([false, true])("loads Papers even when a file is opened while the initial paper scan is pending (save: %s)", async (saveBeforeScan) => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", "references.bib") });
    const paper = {
      arxivId: "", citationKey: "hinton06", title: "A Fast Learning Algorithm for Deep Belief Nets",
      authors: "Hinton, Geoffrey E.", hasFullText: false, hasBlog: false,
    };
    const firstScan = deferred<unknown[]>();
    let scanCalls = 0;
    renderApp({
      initial_project: snapshot,
      list_papers: () => (++scanCalls === 1 ? firstScan.promise : [{ ...paper, title: "Updated title" }]),
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      read_project_file: readFiles({
        "references.bib": "@article{hinton06,title={A Fast Learning Algorithm for Deep Belief Nets}}",
      }, "Main"),
    });
    await waitFor(() => expect(scanCalls).toBeGreaterThan(0));
    fireEvent.click(await findProjectTreeItem("references.bib", 10_000));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent("@article{hinton06"), { timeout: 10_000 });
    if (saveBeforeScan) {
      const view = editorViewAt(".source-editor .cm-editor");
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "@article{hinton06,title={Updated title}}" } }));
      fireEvent.keyDown(window, { key: "s", metaKey: true });
      await waitFor(() => expect(scanCalls).toBe(2));
      expect(await screen.findByText("Updated title")).toBeInTheDocument();
    }
    await act(async () => firstScan.resolve([paper]));
    expect(await screen.findByText(saveBeforeScan ? "Updated title" : paper.title)).toBeInTheDocument();
    expect(document.querySelector(".source-editor .cm-content")).toHaveTextContent("@article{hinton06");
  });

  it.each(["references.bib", "other.bib"])("formats %s on save and refreshes Papers without losing later edits", async (path) => {
    const snapshot = projectSnapshot({ files: fileNodes("main.tex", path) });
    const original = "@article{x,title={Old},author={Ada},year={2024}}";
    const edited = "@article{x,title={New},author={Ada},year={2024}}";
    const formatted = "@article{x,\n  title = {New},\n  author = {Ada},\n  year = {2024}\n}";
    let finishWrite: (() => void) | undefined;
    let saved = false;
    persistLayout(snapshot.root, {
      openTabs: ["main.tex", path], activeFile: path, canvasMode: "source", documentMode: "source", paperView: "fulltext",
      tabRecency: [path, "main.tex"],
    });
    renderApp({
      initial_project: snapshot, refresh_project: snapshot, read_project_file: readFiles({ [path]: original }, "Main"),
      list_papers: () => [{ arxivId: "bib:x", title: saved ? "New" : "Old", authors: "Ada", hasFullText: false, hasBlog: false }],
      // The bibliography refresh must not wait for unrelated project scans.
      list_history: () => (saved ? new Promise(() => {}) : []),
      write_project_file: async (args) => {
        await new Promise<void>(resolve => { finishWrite = resolve; });
        saved = true;
        return { content: (args as { content: string }).content, hadConflicts: false };
      },
    });
    const view = await expectEditorText(original, ".source-editor[data-editor-pane='primary'] .cm-editor", { timeout: 10_000 });
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: edited } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(finishWrite).toBeDefined(), { timeout: 3000 });
    expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({ path, content: formatted, baseContent: original }));
    await waitFor(() => expect(view.state.doc.toString()).toBe(formatted));
    const paperCalls = invokeCalls("list_papers").length;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% later edit" } });
    finishWrite!();
    await waitFor(() => {
      expect(saved).toBe(true);
      expect(invokeCalls("list_papers").length).toBeGreaterThan(paperCalls);
    });
    expect(view.state.doc.toString()).toBe(`${formatted}\n% later edit`);
    await screen.findByText("New", { selector: "strong" });
    expect(screen.queryByText("Old", { selector: "strong" })).not.toBeInTheDocument();
  });

  /** Renders main.tex and a second TeX file, each read as `content:<path>`, answering saves with `write`. */
  const renderTexPair = (write: CommandResult, second = "intro.tex") => renderApp({
    ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", second) })), read_project_file: readPathContent,
    write_project_file: write,
  });

  it("overlaps the pre-switch save with the next file's read and gates the commit on it", async () => {
    const writeResolvers: Array<() => void> = [];
    renderTexPair(() => new Promise<void>((resolve) => writeResolvers.push(resolve)));
    await appendToEditor("\nEdited.");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    // The read of the next file starts while the previous file's write is
    // still pending — they used to run serially.
    await expectInvoked("read_project_file", expect.objectContaining({ path: "intro.tex" }));
    expect(writeResolvers.length).toBeGreaterThan(0);
    // But the switch must not commit until the save confirms.
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    writeResolvers.splice(0).forEach((resolve) => resolve());
    await waitForSelectedTab("intro.tex");
  });

  it("keeps the current document when the pre-switch save fails", async () => {
    renderTexPair(() => { throw new Error("disk full"); });
    await appendToEditor("\nEdited.");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await expectNotification(/Could not save main\.tex/);
    expect(screen.getByRole("tab", { name: /main\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: /intro\.tex/ })).toBeNull();
  });

  it("opens relative project files from Markdown previews", async () => {
    const snapshot = projectSnapshot({
      files: [fileNode("main.tex"), dirNode("notes", fileNodes("notes/index.md", "notes/native-unified-view.md"))],
    });
    persistLayout(snapshot.root, { openTabs: ["notes/index.md"], activeFile: "notes/index.md", canvasMode: "split" });

    await Promise.all([loadTextLanguageExtensions("notes/index.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: readFiles({
        "notes/index.md": "---\ntitle: Exact metadata\n---\n[Native unified view](native-unified-view.md)\n\n-\n  [ ] Review preview",
      }, "# Native unified view"),
    });
    const editor = await waitFor(() => {
      const view = editorViewAt(".source-editor .cm-editor");
      expect(view.state.doc.toString()).toContain("[Native unified view]");
      expect(syntaxTree(view.state).toString()).toContain("Link(");
      return view;
    }, { timeout: 10_000 });
    const documentView = screen.getByRole("tablist", { name: "Document view" });
    const scrollContainer = () => screen.getByTestId("editor-scroll-container");
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(await screen.findByTestId("editor-scroll-container")).toHaveStyle({ overflowAnchor: "none" });
    const visualEditor = visualEditorOf(await screen.findByRole("textbox", { name: "Markdown document editor" }));
    act(() => {
      visualEditor.commands.setContent(visualDocument(visualEditor, "[Visually edited view](native-unified-view.md)\n\n- [ ] Review preview"));
    });
    await waitFor(() => expect(editor.state.doc.toString()).toContain("[Visually edited view](native-unified-view.md)"));
    // Only the changed link paragraph is rewritten: the task list still means what it did, so it keeps the
    // bytes it was written with (spec R-RT-5).
    expect(editor.state.doc.toString()).toBe(
      "---\ntitle: Exact metadata\n---\n[Visually edited view](native-unified-view.md)\n\n-\n  [ ] Review preview",
    );
    await waitFor(() => expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument());
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(editor.state.doc.toString()).toContain("- [x] Review preview"));

    // Source edits reach the preview on an idle budget rather than per keystroke, but an edit the preview itself
    // published is handed straight back: a document older than the one it last emitted reads as a remote revert and
    // would roll the user's typing back once the budget elapsed. Outlast the budget, twice, and confirm both
    // surfaces still agree.
    const expectPreviewEditKept = () => {
      expect(editor.state.doc.toString()).toContain("- [x] Review preview");
      expect(screen.getByRole("checkbox")).toBeChecked();
      expect(screen.getByRole("link", { name: "Visually edited view" })).toBeInTheDocument();
    };
    await act(() => pause(400));
    expectPreviewEditKept();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("checkbox")).toBeChecked();
    await act(() => pause(400));
    expectPreviewEditKept();

    const initialSplitPreview = scrollContainer();
    editor.scrollDOM.scrollTop = 360;
    initialSplitPreview.scrollTop = 520;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const editEditor = editorViewAt(".source-editor .cm-editor");
    expect(document.querySelector(".markdown-preview")).toBeNull();
    await waitFor(() => expect(editEditor.scrollDOM.scrollTop).toBe(360));

    editEditor.scrollDOM.scrollTop = 420;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const splitEditor = editorViewAt(".source-editor .cm-editor");
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    expect(scrollContainer()).toHaveStyle({ overflowAnchor: "none" });
    await waitFor(() => expect(splitEditor.scrollDOM.scrollTop).toBe(420));
    await waitFor(() => expect(scrollContainer().scrollTop).toBe(420));
    splitEditor.dispatch({
      changes: { from: 0, to: splitEditor.state.doc.length, insert: "[Updated native view](native-unified-view.md)" },
    });
    // Re-rendering the preview costs a full parse of the document, so source keystrokes reach it on an idle budget
    // instead of one parse per key. The edit is still pending on the commit that follows the dispatch, and lands
    // once typing stops.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("link", { name: "Updated native view" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Updated native view" })).toBeInTheDocument();

    scrollContainer().scrollTop = 540;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const previewViewport = scrollContainer();
    expect(previewViewport.style.overflowAnchor).toBe("");
    await waitFor(() => expect(previewViewport.scrollTop).toBe(540));

    // Preview and Split mount separate visual-editor roots. Ordinary toolbar switches must hand the viewport to the
    // replacement just like the explicit View in Source action below does.
    await act(() => nextFrames(2));
    const ordinaryPreviewViewport = scrollContainer();
    let ordinaryPreviewScrollTop = 560;
    Object.defineProperty(ordinaryPreviewViewport, "scrollTop", {
      configurable: true,
      get: () => ordinaryPreviewViewport.isConnected ? ordinaryPreviewScrollTop : 0,
      set: (value: number) => { ordinaryPreviewScrollTop = value; },
    });
    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    const ordinarySplitViewport = scrollContainer();
    await waitFor(() => expect(ordinarySplitViewport.scrollTop).toBe(560));
    ordinarySplitViewport.scrollTop = 570;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(scrollContainer().scrollTop).toBe(570));

    const previewEditor = visualEditorOf(screen.getByRole("textbox", { name: "Markdown document editor" }));
    act(() => { previewEditor.chain().focus().setTextSelection({ from: 1, to: 8 }).run(); });
    const viewSourceButton = await screen.findByRole("button", { name: "View in source Markdown" });
    const explicitPreviewViewport = scrollContainer();
    explicitPreviewViewport.scrollTop = 480;
    fireEvent.click(viewSourceButton);
    expect(await screen.findByRole("separator", { name: "Resize editor and Markdown preview" })).toBeInTheDocument();
    const splitPreviewViewport = scrollContainer();
    expect(splitPreviewViewport).not.toBe(explicitPreviewViewport);
    const revealedEditor = editorViewAt(".source-editor .cm-editor");
    // The visual selection starts on the link's first visible character. Its exact Markdown position is after the
    // opening `[`, rather than the old block-level fallback at offset zero.
    await waitFor(() => expect(revealedEditor.state.selection.main.head).toBe(1));

    // Exercise the settled Split geometry directly: the selected source-backed block has content center 920, while
    // its source range has center 610. View in Source must put both at the center of their 400px viewports.
    await act(() => nextFrames(3));
    stubScrollBox(splitPreviewViewport, 400, 2_000);
    stubScrollBox(revealedEditor.scrollDOM, 400, 3_000);
    splitPreviewViewport.scrollTop = 300;
    const previewRectSpy = stubRect(splitPreviewViewport, 0, 100, 500, 400);
    const sourceBackedBlock = splitPreviewViewport.querySelector<HTMLElement>("[data-source-offset='0']");
    if (!sourceBackedBlock) throw new Error("Split Preview did not publish a source-backed block.");
    const sourceBackedBlockRectSpy = vi.spyOn(sourceBackedBlock, "getBoundingClientRect").mockImplementation(() => {
      const top = 1_000 - splitPreviewViewport.scrollTop;
      return { x: 0, y: top, top, bottom: top + 40, left: 0, right: 500, width: 500, height: 40, toJSON: () => ({}) };
    });
    const lineBlockSpy = vi.spyOn(revealedEditor, "lineBlockAt").mockReturnValue({ top: 600, bottom: 620 } as never);
    const splitVisualEditor = visualEditorOf(screen.getByRole("textbox", { name: "Markdown document editor" }));
    act(() => { splitVisualEditor.chain().focus().setTextSelection({ from: 1, to: 8 }).run(); });
    fireEvent.click(await screen.findByRole("button", { name: "View in source Markdown" }));
    await waitFor(() => expect(revealedEditor.scrollDOM.scrollTop).toBe(410));
    await waitFor(() => expect(splitPreviewViewport.scrollTop).toBe(720));
    await act(() => nextFrames(3));

    // The first tiny source scroll must not perform a deferred correction.
    fireEvent.scroll(revealedEditor.scrollDOM);
    await act(() => nextFrames(2));
    expect(splitPreviewViewport.scrollTop).toBe(720);
    lineBlockSpy.mockRestore();
    previewRectSpy.mockRestore();
    sourceBackedBlockRectSpy.mockRestore();

    splitPreviewViewport.scrollTop = 580;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    await waitFor(() => expect(document.querySelector(".source-editor .cm-editor")).toBeNull());
    const restoredPreviewViewport = scrollContainer();
    await waitFor(() => expect(restoredPreviewViewport.scrollTop).toBe(580));

    restoredPreviewViewport.scrollTop = 640;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    const restoredEditEditor = editorViewAt(".source-editor .cm-editor");
    await waitFor(() => expect(restoredEditEditor.scrollDOM.scrollTop).toBe(640));

    stubScrollBox(restoredEditEditor.scrollDOM, 1_000, 3_000);
    restoredEditEditor.scrollDOM.scrollTop = 1_000;
    fireEvent.click(within(documentView).getByRole("tab", { name: "Preview" }));
    const sourceMappedPreviewViewport = scrollContainer();
    // Keep the handoff pending beyond the old two-frame window, as happens
    // while the lazy visual-editor chunk or its scroll geometry is settling.
    await act(() => nextFrames(4));
    stubScrollBox(sourceMappedPreviewViewport, 1_000, 5_000);
    await waitFor(() => expect(sourceMappedPreviewViewport.scrollTop).toBe(2_000));
    fireEvent.click(await screen.findByRole("link", { name: "Updated native view" }), { metaKey: true });

    await expectInvoked("read_project_file", { path: "notes/native-unified-view.md" });
    expect(await screen.findByRole("tab", { name: /native-unified-view\.md/ })).toHaveAttribute("aria-selected", "true");
  }, 40_000);

  it("opens project-root Slides, Sheets, and boards from nested Markdown links", async () => {
    const snapshot = projectSnapshot({
      files: [
        fileNode("main.tex"), dirNode("notes", [fileNode("notes/index.md")]),
        dirNode("slides", [dirNode("slides/native", [fileNode("slides/native/index.tsx")])]),
        ...fileNodes("results.lattice-sheet", "sketch.tldr"),
      ],
    });
    const contentByPath: Record<string, string> = {
      "notes/index.md": "[Open slides](slides/native/index.tsx)\n\n[Open sheet](results.lattice-sheet)\n\n[Open board](sketch.tldr)",
      "slides/native/index.tsx": "export default [];\n", "results.lattice-sheet": "{}", "sketch.tldr": EMPTY_BOARD,
    };
    persistLayout(snapshot.root, { openTabs: ["notes/index.md"], activeFile: "notes/index.md", canvasMode: "split" });

    await Promise.all([loadTextLanguageExtensions("notes/index.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: (args) => {
        if (argPath(args) in contentByPath) return contentByPath[argPath(args)];
        throw new Error(`Unexpected project path: ${argPath(args)}`);
      },
    });

    await waitFor(() => expect(document.querySelector(".source-editor .cm-content"))
      .toHaveTextContent("[Open slides]"), { timeout: 20_000 });
    expect(document.querySelector(".markdown-preview")).not.toBeNull();
    fireEvent.click(await screen.findByRole("link", { name: "Open slides" }));
    expect(await screen.findByTestId("open-slide-workspace-mock")).toHaveAttribute("data-path", "slides/native/index.tsx");
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", { path: "notes/slides/native/index.tsx", projectRoot: snapshot.root });

    for (const [link, editor, path] of [
      ["Open sheet", "spreadsheet-editor-mock", "results.lattice-sheet"], ["Open board", "board-editor-mock", "sketch.tldr"],
    ]) {
      fireEvent.click(screen.getByRole("tab", { name: /index\.md/ }));
      fireEvent.click(await screen.findByRole("link", { name: link }));
      expect(await screen.findByTestId(editor)).toBeInTheDocument();
      expect(invoke).toHaveBeenCalledWith("read_project_file", { path, projectRoot: snapshot.root });
    }
  }, 40_000);

  it("opens HTML documents in an interactive sandboxed preview with Edit and Split views", async () => {
    const snapshot = projectSnapshot({
      rootDocuments: rootDocument("report.html", "Results"),
      files: [
        fileNode("report.html", "text", { contentKind: "text", size: 8 * 1024 * 1024 + 1 }),
        fileNode("figures/chart.html", "text", { contentKind: "text" }),
      ],
    });
    let imageBase64 = "iVBORw0KGgo=";
    renderApp({
      ...refreshableProject(snapshot), write_project_file: undefined,
      read_project_file: readFiles({
        "report.html": "<!doctype html><html><head><base href='https://example.com/'><style>h1{color:tomato}</style></head><body><h1 id='results'>Results</h1><img src='figures/figure1_feature_retention.png' alt='Feature Retention'><iframe src='figures/chart.html' title='Plot'></iframe><button onclick='this.textContent=&quot;Done&quot;'>Run</button><a href='./details.html'>Details</a><a href='#results'>Jump</a><script>window.previewReady=true</script></body></html>",
      }),
      read_project_asset: (args) => argPath(args) === "figures/chart.html" ? {
        path: "figures/chart.html", mimeType: "text/html",
        base64: btoa("<!doctype html><html><body><div id='plot'></div><script>Plotly.newPlot('plot', [], {})</script></body></html>"),
      } : { path: argPath(args), mimeType: "image/png", base64: imageBase64 },
    });
    const documentView = await screen.findByRole("tablist", { name: "Document view" });
    const previewTitle = "HTML preview for report.html";
    expect(screen.queryByTitle(previewTitle)).not.toBeInTheDocument();
    fireEvent.pointerDown(documentView);
    const preview = await screen.findByTitle<HTMLIFrameElement>(previewTitle, {}, { timeout: 30_000 });
    const srcdoc = () => preview.getAttribute("srcdoc");
    expect(within(documentView).getByRole("tab", { name: "Preview" })).toHaveAttribute("aria-selected", "true");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
    for (const kept of [
      '<h1 id="results">Results</h1>', "h1{color:tomato}", "<script>window.previewReady=true</script>", "onclick=",
      '<base href="about:blank">', "href=\"#results\"", 'data-lattice-preview="fragment-navigation"',
      "target.scrollIntoView()", "lattice:html-preview-open-external",
    ]) expect(srcdoc()).toContain(kept);
    expect(srcdoc()).not.toContain("https://example.com/");
    expect(srcdoc()).not.toContain("href=\"./details.html\"");
    await waitFor(() => expect(srcdoc()).toContain('src="data:image/png;base64,iVBORw0KGgo="'));
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/figure1_feature_retention.png", projectRoot: ROOT });
    await waitFor(() => expect(srcdoc()).toContain("Plotly.newPlot"));
    expect(srcdoc()).not.toContain('src="figures/chart.html"');
    expect(srcdoc()).toContain('sandbox="allow-scripts"');
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/chart.html", projectRoot: ROOT });

    const assetReadsBeforePaperFetch = invokeCalls("read_project_asset").length;
    imageBase64 = "bmV3LWltYWdl";
    await selectPanelTab("Agent");
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(tauriEventApi.handlers.get("project-fs-changed")?.size).toBeGreaterThan(0));
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: [".research/papers/1706.03762/paper.md"] });
    await act(async () => { await pause(0); });
    expect(invokeCalls("read_project_asset")).toHaveLength(assetReadsBeforePaperFetch);
    expect(srcdoc()).toContain('src="data:image/png;base64,iVBORw0KGgo="');

    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["figures/figure1_feature_retention.png"] });
    await waitFor(() => expect(srcdoc()).toContain('src="data:image/png;base64,bmV3LWltYWdl"'));

    const zoomMessages = vi.spyOn(preview.contentWindow!, "postMessage");
    const zoomPercentage = () => screen.getByLabelText("HTML zoom percentage");
    expect(zoomPercentage()).toHaveValue("100");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomPercentage()).toHaveValue("110");
    expect(zoomMessages).toHaveBeenCalledWith({ type: "lattice:html-preview-set-zoom", scale: 1.1 }, "*");

    await waitFor(() => expect(preview.contentDocument?.readyState).toBe("complete"));
    postWindowMessage(preview.contentWindow, { type: "lattice:html-preview-open-external", href: "https://arxiv.org/abs/2110.04366" }, "");
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(new URL("https://arxiv.org/abs/2110.04366")));

    fireEvent.click(within(documentView).getByRole("tab", { name: "Edit" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(screen.queryByTitle(previewTitle)).not.toBeInTheDocument();

    fireEvent.click(within(documentView).getByRole("tab", { name: "Split" }));
    expect(document.querySelector(".source-editor .cm-editor")).not.toBeNull();
    expect(await screen.findByTitle(previewTitle)).toBeInTheDocument();
    expect(zoomPercentage()).toHaveValue("110");
    expect(screen.getByRole("separator", { name: "Resize editor and HTML preview" })).toBeInTheDocument();

    const editor = editorViewAt(".source-editor .cm-editor");
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "<!doctype html><html><body><h2>Updated results</h2></body></html>" },
    });
    await waitFor(() => expect(screen.getByTitle(previewTitle).getAttribute("srcdoc")).toContain("<h2>Updated results</h2>"));

    // Republishing srcdoc reloads the frame, so the reader's position has to be carried across it — otherwise every
    // pause in typing threw the author back to the top of their own document.
    const reloaded = screen.getByTitle<HTMLIFrameElement>(previewTitle);
    postWindowMessage(reloaded.contentWindow, {
      type: "lattice:html-preview-scroll", clientHeight: 600, scrollHeight: 4000, scrollTop: 420,
    }, "");
    const postMessage = vi.spyOn(reloaded.contentWindow!, "postMessage");
    fireEvent.load(reloaded);
    expect(postMessage).toHaveBeenCalledWith({ type: "lattice:html-preview-set-scroll-top", scrollTop: 420 }, "*");

    stubScrollBox(editor.scrollDOM, 600, 2600);
    editor.scrollDOM.scrollTop = 1000;
    postMessage.mockClear();
    fireEvent.scroll(editor.scrollDOM);
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "lattice:html-preview-set-scroll-top", scrollTop: 1700 }, "*"));
  });

  it("adds and removes project dictionary terms from Editor settings", async () => {
    const snapshot = projectSnapshot({ spellingWords: ["VLM"] });
    renderApp({
      ...projectCommands(snapshot),
      set_project_spelling_words: (args) => {
        snapshot.manifest.spellingWords = (args as { words: string[] }).words;
        return snapshot.manifest;
      },
    });
    await chooseProjectMenuItem("Settings");
    // Settings is lazy; this suite can be the first to open it.
    fireEvent.click(await screen.findByRole("button", { name: "Editor & builds" }));
    expect(screen.getByRole("list", { name: "Project dictionary terms" })).toHaveTextContent("VLM");
    fireEvent.change(screen.getByLabelText("Add project term"), { target: { value: "TexLab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await expectInvoked("set_project_spelling_words", { words: ["VLM", "TexLab"] });
    expect(await screen.findByText("TexLab")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove VLM from project dictionary" }));
    await expectInvoked("set_project_spelling_words", { words: ["TexLab"] });
    expect(screen.queryByText("VLM")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Add project term"), { target: { value: "Synara" } });
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
    expect(screen.getByLabelText("Add project term")).toHaveValue("Synara");
  });
});
