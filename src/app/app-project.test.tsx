import { expectNotification, windowApi, synaraHook, openSlideWorkspaceApi, browserRuntime, fileNode, fileNodes, dirNode, projectCommands, refreshableProject, SINGLE_TRANSFORMER, attentionPaper, overleafLink, overleafStatus, overleafProbe, overleafSyncResult, overleafSession, overleafCommands, ROOT, projectSnapshot, rootDocument, notesSnapshot, markdownSnapshot, buildResult, readFiles, deferred, setAutoBuildMode, setInterfaceLanguage, selectPanelTab, projectTreeRoot, queryProjectTreeItem, findInProjectTree, findProjectTreeItem, findProjectTreeRenameInput, renderApp, renderOverleafPaper, openWithAutomaticBuilds, findElement, editorViewAt, findEditorView, expectEditorText, postWindowMessage, expectInvoked, invokeCalls, pause, stubElementFromPoint, storedFileViews, dropFinderPaths, persistLayout, persistLayoutWithoutAgent, visibleToasts, visualEditorOf, argPath, waitForSelectedTab, openTreeFile, openAgentFrame, postedOfType, dragTreeItem, pdfDocumentStub, mockPdfDocument, chooseNewDocument, openPaper, chooseProjectMenuItem, nextFrames } from "./app-test-utils";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { registerAgentCanvasAdapter } from "../agent/agent-canvas-tools";
import { registerAgentSpreadsheetDocument } from "../agent/agent-spreadsheet-tools";
import { formatAppLogs, getAppToastOptions } from "../telemetry/app-log-store";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";
import type { OpenSlideSyncOperation } from "../editor/presentation/open-slide-bridge";
import type { LayoutDocument } from "@danfessler/trellis";

describe("project tree and projects", () => {
  it("leads an empty command palette with recent commands and the open document's, never a destructive one", async () => {
    renderApp(projectCommands());
    await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    const openPalette = async () => {
      fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
      return screen.findByRole("searchbox", { name: "Command palette" });
    };
    const sections = () => [...document.querySelectorAll(".quick-open-modal [data-slot='picker-section-label']")].map((label) => label.textContent);
    const options = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
    const run = async (label: string) => {
      const input = await openPalette();
      fireEvent.change(input, { target: { value: label } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());
    };

    await openPalette();
    expect(sections()[0]).toBe("In this document");
    // No PDF yet, so nothing to jump to.
    expect(options().slice(0, 3)).toEqual(["Build project⌘S", "Insert citation⌘⇧K", "Insert reference⌘⇧L"]);
    expect(options().filter((option) => option.startsWith("Jump to PDF"))).toEqual([]);
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());

    await run("Clean aux files");
    await run("Insert citation");
    fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Insert citation" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Insert citation" })).not.toBeInTheDocument());
    // Only ids are kept: not the typed query, nothing from the document.
    expect(JSON.parse(localStorage.getItem("lattice.recent-commands.v1")!)).toEqual(["cite", "clean"]);

    await openPalette();
    expect(sections().slice(0, 2)).toEqual(["Recent", "In this document"]);
    expect(options().slice(0, 3)).toEqual(["Insert citation⌘⇧K", "Build project⌘S", "Insert reference⌘⇧L"]);
    expect(options().filter((option) => option.startsWith("Insert citation"))).toHaveLength(1);
    expect(options().filter((option) => option.startsWith("Clean aux files"))).toHaveLength(1);
  });

  it("hides the chrome for focus mode on ⌘⇧D and gives the layout back on Escape", async () => {
    renderApp(projectCommands());
    const editor = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    const shell = document.querySelector(".app-shell")!;
    // Which panels are back; where each sits is trellis-layout's to test.
    const shownTabs = () => screen.queryAllByRole("tab").map((tab) => tab.textContent ?? "").filter((name) => /Project|Papers|PDF|main\.tex/.test(name)).sort();
    await waitFor(() => expect(shownTabs().length).toBeGreaterThan(1));
    const before = shownTabs();

    fireEvent.keyDown(window, { key: "D", code: "KeyD", metaKey: true, shiftKey: true });
    await waitFor(() => expect(shell).toHaveClass("focus-mode"));
    expect(screen.queryByRole("button", { name: "Switch project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Exit focus/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the PDF beside the editor" })).toHaveAttribute("aria-pressed", "false");

    // The editor's own Escape (collapsing a selection) comes first.
    editor.dispatch({ selection: { anchor: 0, head: 4 } });
    fireEvent.keyDown(editor.contentDOM, { key: "Escape" });
    expect(shell).toHaveClass("focus-mode");
    fireEvent.keyDown(editor.contentDOM, { key: "Escape" });
    await waitFor(() => expect(shell).not.toHaveClass("focus-mode"));
    expect(screen.getByRole("button", { name: "Switch project" })).toBeInTheDocument();
    await waitFor(() => expect(shownTabs()).toEqual(before));
  });

  it("lists every shortcut on ⌘?, from the commands and the keymaps, filtered by name", async () => {
    renderApp(projectCommands());
    await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    fireEvent.keyDown(window, { key: "?", metaKey: true, shiftKey: true });
    const sheet = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const group = (name: string) => within(within(sheet).getByRole("region", { name }));
    expect(group("Build").getByText("Save and build")).toBeInTheDocument();
    expect(group("Layout").getByText("Focus mode")).toBeInTheDocument();
    expect(group("LaTeX").getByText("Wrap in environment…")).toBeInTheDocument();
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Filter shortcuts" }), { target: { value: "insert citation" } });
    expect(within(sheet).getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Edit"]);
    fireEvent.keyDown(within(sheet).getByRole("searchbox", { name: "Filter shortcuts" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
  });

  it("finds files and Papers from the palette, and leads with the files opened before", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "chapters/intro.tex", "notes.md") })),
      read_project_file: readFiles({ "chapters/intro.tex": "\\section{Intro}", "notes.md": "# Notes" }),
      list_papers: () => [attentionPaper({ authors: "Vaswani, Ashish and Shazeer, Noam", year: "2017" })],
      read_paper: "# Attention\n\nPaper content.",
    });
    await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    const palette = async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      return screen.findByRole("searchbox", { name: "Command palette" });
    };
    const sections = () => [...document.querySelectorAll(".quick-open-modal [data-slot='picker-section-label']")].map((label) => label.textContent);

    fireEvent.change(await palette(), { target: { value: "intro" } });
    expect(sections()).toContain("Files");
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Command palette" }), { key: "Enter" });
    await waitForSelectedTab("chapters/intro.tex");

    // The file shown before this one leads its group; the open one is not offered.
    await palette();
    expect(sections()).toContain("Recent files");
    expect(screen.getByRole("option", { name: "main.tex" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "chapters/intro.tex" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Command palette" }), { target: { value: "vaswani" } });
    fireEvent.click(screen.getByRole("option", { name: /Attention Is All You Need/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Attention Is All You Need/ })).toHaveAttribute("aria-selected", "true"));
  });

  it("starts a new file from the palette with its name field focused, even when the editor had focus", async () => {
    renderApp(refreshableProject(projectSnapshot(), ""));
    const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    view.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByRole("searchbox", { name: "Command palette" });
    fireEvent.change(input, { target: { value: "New LaTeX file" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const name = await findProjectTreeRenameInput();
    expect(name).toHaveValue("untitled.tex");
    // The palette's own focus return (its FocusScope's, a timer later) must not take it back.
    await nextFrames(3);
    await waitFor(() => expect(name.getRootNode() instanceof ShadowRoot ? (name.getRootNode() as ShadowRoot).activeElement : document.activeElement).toBe(name));
  });

  it("lists in a saved paper's palette only the commands it can run, whatever was recent", async () => {
    localStorage.setItem("lattice.recent-commands.v1", JSON.stringify(["cite", "goto-line", "sync-pdf", "find"]));
    renderApp({ ...projectCommands(), list_papers: () => [attentionPaper()], read_paper: "# Attention\n\nPaper content." });
    await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
    await openPaper("Attention Is All You Need");
    await waitFor(() => expect(screen.getByRole("tab", { name: /Attention Is All You Need/ })).toHaveAttribute("aria-selected", "true"));

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Command palette" });
    const options = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
    expect([...document.querySelectorAll(".quick-open-modal [data-slot='picker-section-label']")].map((label) => label.textContent).slice(0, 2))
      .toEqual(["Recent", "In this paper"]);
    expect(options()[0]).toMatch(/^Find in project/);
    for (const label of ["Insert citation", "Insert reference", "Insert table", "Go to line", "Go to symbol", "Jump to PDF", "Format document"]) {
      expect(options().filter((option) => option.startsWith(label))).toEqual([]);
    }
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "k", metaKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "g", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a project switcher with recent and folder actions", async () => {
    renderApp(projectCommands());
    await screen.findByRole("button", { name: "Switch project" });
    expect(screen.queryByText(ROOT)).not.toBeInTheDocument();
    expect(document.querySelector(".titlebar-navigator")).not.toHaveAttribute("style");
    fireEvent.mouseDown(document.querySelector(".titlebar-drag-area")!, { button: 0, buttons: 1 });
    await waitFor(() => expect(windowApi.startDragging).toHaveBeenCalledOnce());
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Switch project" }), { button: 0 });

    expect(await screen.findByText("Recent projects")).toBeInTheDocument();
    const projectMenu = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(projectMenu).toHaveClass("w-52");
    expect(projectMenu).toHaveAttribute("data-align", "center");
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Light" })).not.toBeInTheDocument();
    for (const name of ["Settings", "Guided tutorial", /open another folder/i, /new project/i]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Add file or folder" })).not.toBeInTheDocument();
    expect(document.querySelector(".source-editor > .code-editor-root")).toBeInTheDocument();
    // The title bar holds the panel controls, then the project's tools; each document's tools sit in its panel.
    const titlebarMain = document.querySelector(".titlebar .titlebar-main")!;
    const panelControls = titlebarMain.querySelector<HTMLElement>(".trellis-titlebar")!;
    const titlebarTools = titlebarMain.querySelector(".canvas-toolbar")!;
    expect(within(panelControls).getByRole("button", { name: "Panels" })).toBeInTheDocument();
    expect(within(panelControls).getByRole("button", { name: "Hide Project" })).toHaveAttribute("aria-pressed", "true");
    // The Panels menu keeps maximize and reset; neither the whole-workspace
    // overview nor the Trellis credit is there. The credit is kept in the native
    // macOS About panel (src-tauri/src/native_locale.rs) and in NOTICE / THIRD_PARTY_NOTICES.
    fireEvent.pointerDown(within(panelControls).getByRole("button", { name: "Panels" }), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: /Maximize focused panel/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reset layout" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Zoom out to show every panel/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Uses Trellis/)).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Reset layout" })).not.toBeInTheDocument());
    expect([...titlebarMain.children].indexOf(panelControls)).toBeLessThan([...titlebarMain.children].indexOf(titlebarTools));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Project history" }));
    expect(titlebarTools).toContainElement(screen.getByRole("button", { name: "Git status and commit" }));
    expect(titlebarTools).not.toContainElement(screen.getByRole("button", { name: "Build" }));
    await selectPanelTab("Agent");
    expect(document.querySelector('iframe[title="Agent"]')).toHaveAttribute("src", expect.stringContaining("127.0.0.1:4173"));
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
  });

  it.each(["fullscreen", "a browser tab"])("moves the navigator control to the left edge in %s", async (host) => {
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

    it("saves and freezes a browser tab's editor while it returns the workspace, and releases it unless the tab detaches", async () => {
      browserRuntime.hosted = true;
      const returns = [deferred(), deferred()];
      openProject({
        return_to_desktop: () => returns.shift()!.promise,
        write_project_file: (args: unknown) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% typed before the switch" } }));
      const [failed, answered] = returns;
      fireEvent.click(await screen.findByRole("button", { name: "Open in Lattice app" }));
      await expectInvoked("return_to_desktop");
      expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({
        path: "main.tex", content: expect.stringContaining("% typed before the switch"),
      }));
      await waitFor(() => expect(view.state.facet(EditorView.editable)).toBe(false));
      expect(view.contentDOM).toHaveAttribute("contenteditable", "false");

      await act(async () => { failed.reject(new Error("Lattice could not open its window")); });
      await expectNotification(/Lattice could not open its window/);
      await waitFor(() => expect(view.state.facet(EditorView.editable)).toBe(true));

      // A reply that leaves the tab attached means the workspace stayed here.
      vi.mocked(invoke).mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Open in Lattice app" }));
      await expectInvoked("return_to_desktop");
      await waitFor(() => expect(view.state.facet(EditorView.editable)).toBe(false));
      await act(async () => { answered.resolve(); });
      await waitFor(() => expect(view.state.facet(EditorView.editable)).toBe(true));
    });

    it("keeps a browser tab's workspace when its save fails", async () => {
      browserRuntime.hosted = true;
      openProject({ write_project_file: () => { throw new Error("disk full"); } });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
      fireEvent.click(await screen.findByRole("button", { name: "Open in Lattice app" }));
      await waitFor(() => expect(invokeCalls("write_project_file")).not.toHaveLength(0));
      await pause(50);
      expect(invokeCalls("return_to_desktop")).toHaveLength(0);
      expect(view.state.doc.toString()).toContain("% unsaved");
    });
  });

  describe("resetting the layout", () => {
    const agentTab = () => document.querySelector('[data-trellis-part="tab"][data-type="agent"]');
    // A workspace's tab also names its unsaved changes, if any.
    const layoutTab = (name: string) => within(document.querySelector(".trellis-presets")!).getByRole("tab", { name: new RegExp(`^${name}\\s*(Unsaved changes)?$`) });
    const resetLayout = () => fireEvent.click(within(document.querySelector<HTMLElement>(".trellis-titlebar")!).getByRole("button", { name: "Reset layout" }));
    // The toast stack is not rendered here (see expectNotification): read the offer from the store.
    const resetToast = () => visibleToasts("Layout").find((entry) => entry?.title === "Layout reset");
    const undo = () => act(async () => { await getAppToastOptions(resetToast()!.id)?.primaryAction?.onClick(); });

    it("offers Undo, which brings back the arrangement and the layout it was in", async () => {
      // The writer closed the Agent; the default layout has it behind Project.
      persistLayoutWithoutAgent();
      renderApp(projectCommands());
      // The workspace is up once the open document has its editor.
      await findEditorView();
      expect(agentTab()).toBeNull();
      fireEvent.click(layoutTab("Writing"));
      await waitFor(() => expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true"));

      resetLayout();
      await waitFor(() => expect(agentTab()).not.toBeNull());
      expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(getAppToastOptions(resetToast()!.id)?.primaryAction?.label).toBe("Undo"));
      // Placing the open documents back is the reset's own doing: the offer stands.
      await pause(300);
      await undo();
      await waitFor(() => expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true"));
      // Writing returns to the writer's own layout, still without the Agent.
      fireEvent.click(layoutTab("Workspace"));
      await waitFor(() => expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true"));
      expect(agentTab()).toBeNull();
      // The offer is spent: a second Undo changes nothing.
      await undo();
      expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
      // Saved without it, too (saves are debounced).
      const saved = () => JSON.parse(localStorage.getItem(`lattice.trellis-layout.v1:${ROOT}`) ?? "null") as { document: LayoutDocument } | null;
      await waitFor(() => {
        expect(saved()).not.toBeNull();
        expect(saved()!.document.views.agent).toBeUndefined();
      });
    });

    it("takes the offer back once the layout changes again", async () => {
      persistLayoutWithoutAgent();
      renderApp(projectCommands());
      await findEditorView();
      resetLayout();
      await waitFor(() => expect(resetToast()).toBeDefined());
      fireEvent.click(layoutTab("Reading"));
      await waitFor(() => expect(resetToast()).toBeUndefined());
    });

    it("neither resets nor offers Undo when saving first fails", async () => {
      renderApp({ ...projectCommands(), write_project_file: () => { throw new Error("disk full"); } });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
      resetLayout();
      await expectNotification(/Save failed, so the layout was not reset/);
      expect(resetToast()).toBeUndefined();
    });

    it("resets once, keeping the arrangement to undo to, when asked again while saving first", async () => {
      persistLayoutWithoutAgent();
      const written = deferred();
      renderApp({ ...projectCommands(), write_project_file: () => written.promise });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      fireEvent.click(layoutTab("Writing"));
      await waitFor(() => expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true"));
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
      resetLayout();
      await waitFor(() => expect(invokeCalls("write_project_file")).toHaveLength(1));
      // A second press while the first reset still waits on its save.
      resetLayout();
      await act(async () => { written.resolve(); });
      await waitFor(() => expect(getAppToastOptions(resetToast()!.id)?.primaryAction?.label).toBe("Undo"));
      expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
      await pause(300);
      // Undo brings back what the writer had, not the default the first reset left.
      await undo();
      await waitFor(() => expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true"));
      expect(invokeCalls("write_project_file")).toHaveLength(1);
    });

    describe("when the project changes while its save is pending", () => {
      const NEXT_ROOT = "/tmp/next-project";
      const storedLayout = () => localStorage.getItem(`lattice.trellis-layout.v1:${ROOT}`);
      // Reset in the first project with an edit to save first, holding that
      // save's answer, then switch to the next project in this window (the
      // tutorial still does so) and put it in the Writing layout.
      async function resetThenSwitch(written: Promise<void>) {
        persistLayoutWithoutAgent();
        let first = true;
        renderApp({
          ...projectCommands(),
          open_tutorial_project: () => projectSnapshot({ root: NEXT_ROOT, name: "Next project" }),
          write_project_file: () => {
            if (!first) return undefined;
            first = false;
            return written;
          },
        });
        const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
        act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
        resetLayout();
        await waitFor(() => expect(invokeCalls("write_project_file")).toHaveLength(1));
        await chooseProjectMenuItem("Guided tutorial");
        await expectInvoked("open_tutorial_project");
        await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Next project"));
        await findEditorView();
        fireEvent.click(layoutTab("Writing"));
        await waitFor(() => expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true"));
        // What the first project left saved, which its late reset must not clear.
        const outgoing = storedLayout();
        expect(outgoing).not.toBeNull();
        return outgoing;
      }

      it("does not reset either project or offer Undo once the save lands", async () => {
        const written = deferred();
        const outgoing = await resetThenSwitch(written.promise);
        await act(async () => { written.resolve(); });
        await pause(100);
        expect(resetToast()).toBeUndefined();
        expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true");
        expect(storedLayout()).toBe(outgoing);
      });

      it("does not report the reset as failed in the next project when the save fails", async () => {
        const written = deferred();
        const outgoing = await resetThenSwitch(written.promise);
        await act(async () => { written.reject(new Error("disk full")); });
        await pause(100);
        expect(formatAppLogs()).not.toMatch(/the layout was not reset/);
        expect(resetToast()).toBeUndefined();
        expect(layoutTab("Writing")).toHaveAttribute("aria-selected", "true");
        expect(storedLayout()).toBe(outgoing);
      });
    });
  });

  it("toggles fullscreen when double-clicking the titlebar drag area", async () => {
    renderApp(projectCommands(projectSnapshot({ files: [] })));
    await screen.findByRole("button", { name: "Switch project" });
    fireEvent.doubleClick(document.querySelector(".titlebar-drag-area")!);
    await waitFor(() => expect(windowApi.setFullscreen).toHaveBeenCalledWith(true));
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
    expect(host?.style.getPropertyValue("--trees-item-height")).toBe("32px");
    expect(host).toHaveAttribute("data-file-tree-virtualized", "true");
    expect((await findProjectTreeItem("component.tsx")).querySelector("[data-icon-token='react']")).not.toBeNull();
    for (const [path, icon] of [
      ["chapters/method/main.tex", "lattice-material-tex"], ["references.bib", "lattice-material-bibliography"],
      ["paper.pdf", "lattice-material-pdf"], ["conference.sty", "lattice-material-tex-style"],
      ["plain.bst", "lattice-material-bibtex-style"], ["figure.eps", "file-tree-builtin-image"],
    ]) expect((await findProjectTreeItem(path)).querySelector("use")).toHaveAttribute("href", `#${icon}`);
    const folderRows = projectTreeRoot()?.querySelectorAll("[data-item-type='folder']");
    expect(new Set(Array.from(folderRows ?? [], (row) => (row as HTMLElement).dataset.itemPath))).toEqual(new Set(["chapters/method/"]));
    for (const trigger of projectTreeRoot()?.querySelectorAll("[data-type='context-menu-trigger']") ?? []) {
      expect(trigger).toHaveAttribute("data-visible", "false");
    }
  });

  it.each(["source pane", "outside input"])("saves pending visual Markdown when focus moves to %s in manual build mode", async (destination) => {
    setAutoBuildMode("manual");
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    await loadVisualMarkdownEditorModule();
    const snapshot = projectSnapshot({ files: [fileNode("notes.md")] });
    renderApp({ ...refreshableProject(snapshot, "Original paragraph.\n"), write_project_file: undefined });
    const surface = await screen.findByRole("textbox", { name: "Markdown document editor" }, { timeout: 15_000 });
    const editor = visualEditorOf(surface);
    const outsideInput = document.createElement("input");
    document.body.append(outsideInput);
    try {
      act(() => { surface.focus(); });
      vi.mocked(invoke).mockClear();
      act(() => {
        editor.commands.insertContentAt(1, "Latest edit. ");
        (destination === "source pane" ? document.querySelector<HTMLElement>(".cm-content")! : outsideInput).focus();
      });
      // Focus loss must persist the latest transaction, without waiting for
      // either the visual publisher's debounce or the app's idle autosave.
      expect(invoke).toHaveBeenCalledWith("write_project_file", {
        path: "notes.md", content: "Latest edit. Original paragraph.\n", baseContent: "Original paragraph.\n", projectRoot: ROOT,
      });
      expect(invoke).not.toHaveBeenCalledWith("build_project", expect.anything());
    } finally {
      outsideInput.remove();
    }
  });

  it.each(["editor leave", "PDF pointer down", "PDF focus"])("saves and builds changed source on %s", async (trigger) => {
    await openWithAutomaticBuilds({ write_project_file: undefined });
    const view = await findEditorView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nNew result." } });
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    if (trigger === "editor leave") fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    else if (trigger === "PDF pointer down") fireEvent.pointerDown(document.querySelector(".pdf-column")!);
    else fireEvent.focus(document.querySelector(".pdf-column")!);
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nNew result.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    });
    // The open file rides along so the backend can re-target the build on it
    // when it is a compilable root (Overleaf's rule).
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT, documentPath: "main.tex" }));
  });

  it.each(["build", "save"])("saves and queues the latest edit while an automatic %s is in flight", async (heldOperation) => {
    setAutoBuildMode("automatic");
    let releaseBuild: (() => void) | undefined;
    let holdBuild = false;
    let releaseSave: (() => void) | undefined;
    let holdSave = false;
    const builtSources: string[] = [];
    let diskSource = "\\documentclass{article}";
    renderApp({
      ...refreshableProject(projectSnapshot({ files: [] })), read_project_file: () => diskSource,
      write_project_file: async (args) => {
        if (holdSave) {
          holdSave = false;
          await new Promise<void>((resolve) => { releaseSave = resolve; });
        }
        diskSource = (args as { content: string }).content;
      },
      build_project: async () => {
        builtSources.push(diskSource);
        if (holdBuild) {
          holdBuild = false;
          await new Promise<void>((resolve) => { releaseBuild = resolve; });
        }
        return buildResult()();
      },
    });
    const view = await findEditorView();
    const type = (text: string) => {
      act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); });
      fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    };
    await waitFor(() => expect(builtSources).toHaveLength(1));
    holdBuild = heldOperation === "build";
    holdSave = heldOperation === "save";
    type("\nFirst edit.");
    await waitFor(() => expect(heldOperation === "build" ? releaseBuild : releaseSave).toBeDefined());
    try {
      type("\nSecond edit.");
      await act(async () => { releaseSave?.(); });
      await waitFor(() => expect(diskSource).toBe("\\documentclass{article}\nFirst edit.\nSecond edit."));
    } finally {
      await act(async () => { releaseSave?.(); releaseBuild?.(); });
    }
    await waitFor(() => expect(builtSources).toEqual([
      "\\documentclass{article}", "\\documentclass{article}\nFirst edit.", "\\documentclass{article}\nFirst edit.\nSecond edit.",
    ]));
  });

  /** A full-text search hit in a project file. */
  const fileHit = (path: string, line: number, snippet: string, fileKind = "tex") => ({
    kind: "file", path, title: path, snippet, line, fileKind,
  });

  it("opens indexed full-text search from the Project panel and opens file and Blog hits", async () => {
    const paper = { ...SINGLE_TRANSFORMER, hasBlog: true };
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "references.bib") })),
      read_project_file: readFiles({
        "references.bib": "Bibliography\n@article{chen2024single, title={A Single Transformer}}\n",
      }, "Main document\n"),
      list_papers: () => [paper], read_paper: "# Full paper\n\nTransformer details.",
      read_paper_blog_local: "# Chen overview\n\nA residual stream explanation.",
      search_project: () => [
        fileHit("references.bib", 2, "@article{chen2024single, title={A Single Transformer}}", "bib"),
        {
          kind: "paper", path: ".research/papers/2407.06438/blog.md", title: paper.title,
          snippet: "A residual stream explanation.", line: 3, arxivId: paper.arxivId,
        },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Find in project" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Find in project" }), { target: { value: "chen" } });
    await expectInvoked("search_project", { query: "chen" });
    // The query term is marked inside the snippet, so match the whole preview.
    expect(await screen.findByText(
      (_, element) => element?.matches(".project-replace-hit-preview") === true && /@article\{chen2024single/.test(element.textContent ?? ""),
    )).toHaveTextContent("chen2024single");
    expect(document.querySelector(".project-replace-hit-preview mark")).toHaveTextContent(/^chen$/i);
    fireEvent.click(screen.getByTitle("references.bib:2"));
    await waitFor(() => {
      const view = editorViewAt();
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open paper result: A Single Transformer" }));
    await expectInvoked("read_paper_blog_local", { arxivId: "2407.06438" });
    expect(await screen.findByRole("heading", { name: "Chen overview" })).toBeInTheDocument();
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

  it("renames project items but keeps bibliography titles authoritative for papers", async () => {
    localStorage.setItem("lattice.file-view-states.v1", JSON.stringify({
      ROOT: { "main.tex": { text: { cursor: 12, scrollTop: 80 } } },
    }));
    const paper = attentionPaper({ citationKey: "vaswani2017attention" });
    renderApp({ ...refreshableProject(), list_papers: () => [paper], rename_project_entry: "paper.tex" });
    fireEvent.contextMenu(await findProjectTreeItem("main.tex"));
    const fileMenu = await screen.findByRole("menu");
    expect(fileMenu.parentElement).toBe(document.body);
    expect(fileMenu).toHaveStyle({ position: "fixed" });
    fireEvent.click(within(fileMenu).getByRole("menuitem", { name: "Rename" }));
    const renameInput = await findProjectTreeRenameInput();
    fireEvent.input(renameInput, { target: { value: "paper" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await expectInvoked("rename_project_entry", { path: "main.tex", newName: "paper", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /paper\.tex/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /main\.tex/ })).not.toBeInTheDocument();
    expect(await findProjectTreeItem("paper.tex")).toBeInTheDocument();
    await waitFor(() => {
      expect(storedFileViews()[ROOT]?.["main.tex"]).toBeUndefined();
      expect(storedFileViews()[ROOT]?.["paper.tex"]).toBeDefined();
    });
    fireEvent.contextMenu(await screen.findByTitle("Attention Is All You Need"));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });

  /** Expands `directories` in the project tree, as a previous session left them. */
  const expandDirectories = (...directories: string[]) => (
    localStorage.setItem("lattice:expanded-directories:/tmp/lattice-paper", JSON.stringify(directories))
  );

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
      expect(dropTarget("figures/")).toHaveAttribute("data-lattice-pointer-drop-target", "true");
    });
    fireEvent.pointerMove(notes, { clientX: 20, clientY: 35, ...pointer });
    await waitFor(() => expect(dropTarget("notes/")).toHaveAttribute("data-lattice-pointer-drop-target", "true"));
    fireEvent.pointerMove(target, { clientX: 20, clientY: 50, ...pointer });
    await waitFor(() => expect(dropTarget("sections/")).toHaveAttribute("data-lattice-pointer-drop-target", "true"));
    expect(dropTarget("figures/")).not.toHaveAttribute("data-lattice-pointer-drop-target");
    expect(dropTarget("notes/")).not.toHaveAttribute("data-lattice-pointer-drop-target");
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

  it("rebases image paths when an open Markdown file is moved into a folder", async () => {
    expandDirectories("figures");
    renderApp({
      ...refreshableProject(markdownSnapshot("notes.md", [fileNode("notes.md"), dirNode("figures", [fileNode("figures/plot.png")])])),
      read_project_file: '# Notes\n\n<img src="figures/plot.png" alt="Plot" width={223} />\n', move_project_entry: "figures/notes.md",
    });
    await screen.findByRole("textbox", { name: "Markdown document editor" });
    dragTreeItem(await findProjectTreeItem("notes.md"), await findProjectTreeItem("figures/plot.png"));
    await expectInvoked("move_project_entry", { path: "notes.md", targetDirectory: "figures", projectRoot: ROOT });
    await expectInvoked("write_project_file", {
      path: "figures/notes.md", content: '# Notes\n\n<img src="plot.png" alt="Plot" width={223} />\n', projectRoot: ROOT,
    });
  });

  it("treats a same-directory drop as a no-op", async () => {
    renderApp(refreshableProject(projectSnapshot({ files: [dirNode("notes"), ...fileNodes("main.tex", "references.bib")] })));
    const source = await findProjectTreeItem("main.tex");
    const target = await findProjectTreeItem("references.bib");
    const pointer = { clientX: 20, clientY: 20, pointerId: 1, pointerType: "mouse" };
    fireEvent.pointerDown(source, { ...pointer, button: 0, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(target, pointer);
    expect(queryProjectTreeItem("references.bib")).not.toHaveAttribute("data-lattice-pointer-drop-target");
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

  it("imports a Finder source file into the project before opening it", async () => {
    const beforeImport = projectSnapshot();
    const afterImport = { ...beforeImport, files: [...beforeImport.files, fileNode("method.tex")] };
    let imported = false;
    renderApp({
      ...projectCommands(beforeImport), refresh_project: () => imported ? afterImport : beforeImport,
      import_project_sources: () => {
        imported = true;
        return ["method.tex"];
      },
      read_project_file: readFiles({ "method.tex": "\\section{Method}" }),
    });
    stubElementFromPoint(await findElement(".source-editor .cm-content"));
    await dropFinderPaths(["/tmp/method.tex"]);
    await expectInvoked("import_project_sources", { paths: ["/tmp/method.tex"], targetDirectory: "", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /method\.tex/ })).toHaveAttribute("aria-selected", "true");
    expect(await findProjectTreeItem("method.tex")).toBeInTheDocument();
  });

  it("imports and opens a Finder asset dropped onto an asset preview", async () => {
    renderApp({
      ...refreshableProject(projectSnapshot({ files: [dirNode("figures", [fileNode("figures/existing.svg")]), fileNode("main.tex")] })),
      read_project_asset: (args) => {
        const path = argPath(args);
        const png = path.endsWith(".png");
        return { path, mimeType: png ? "image/png" : "image/svg+xml", base64: png ? "iVBORw0KGgo=" : "PHN2Zy8+" };
      },
      import_project_assets: () => ["figures/new.png"], build_project: buildResult(),
    });
    fireEvent.click(await findProjectTreeItem("figures/"));
    fireEvent.click(await findProjectTreeItem("figures/existing.svg"));
    const preview = await screen.findByAltText("Preview of figures/existing.svg");
    const zoomPercentage = screen.getByLabelText("Image zoom percentage");
    expect(zoomPercentage).toHaveValue("100");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomPercentage).toHaveValue("110");
    expect(preview).toHaveStyle({ zoom: "1.1" });
    fireEvent.change(zoomPercentage, { target: { value: "999" } });
    fireEvent.blur(zoomPercentage);
    expect(zoomPercentage).toHaveValue("500");
    expect(preview).toHaveStyle({ zoom: "5" });
    stubElementFromPoint(preview);
    await dropFinderPaths(["/tmp/new.png"]);

    await expectInvoked("import_project_assets", { paths: ["/tmp/new.png"], targetDirectory: "figures", projectRoot: ROOT });
    expect(await screen.findByRole("tab", { name: /new\.png/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByAltText("Preview of figures/new.png")).toHaveStyle({ zoom: "1" });
    expect(screen.getByLabelText("Image zoom percentage")).toHaveValue("100");
    expect(invoke).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());
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
        return [{ path: "main-2.tex", kind: "text" }];
      },
    });
    fireEvent.click(await findProjectTreeItem("main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/lattice-paper/main.tex"));
    fireEvent.keyDown(await findProjectTreeItem("main.tex"), { key: "v", metaKey: true });
    await expectInvoked("import_project_files", {
      paths: ["/tmp/lattice-paper/main.tex"], targetDirectory: "", projectRoot: ROOT, copyExisting: true,
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
    renderApp({ ...refreshableProject(snapshot), import_project_files: () => imported });
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

  it("keeps text-classified SVG tabs as images after switching files", async () => {
    const snapshot = projectSnapshot({
      files: [
        fileNode("main.tex"),
        // Some scanners classify SVG as text. Opening is extension-based,
        // so Quick Open must still route it to the image preview.
        dirNode("figures", [fileNode("figures/diagram.svg", "text", { contentKind: "text" })]),
        { ...dirNode("empty"), contentKind: "directory" },
      ],
    });
    renderApp({
      ...refreshableProject(snapshot),
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/svg+xml", base64: "PHN2Zy8+" }),
    });
    await screen.findByRole("tab", { name: /main\.tex/ });
    fireEvent.keyDown(window, { key: "p", metaKey: true });

    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: "figures" })).toBeNull();
    expect(within(list).queryByRole("option", { name: "empty" })).toBeNull();
    fireEvent.click(within(list).getByRole("option", { name: "figures/diagram.svg" }));

    const svgReadAsText = expect.objectContaining({ path: "figures/diagram.svg" });
    expect(await screen.findByAltText("Preview of figures/diagram.svg")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: "figures/diagram.svg" });
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", svgReadAsText);

    fireEvent.click(screen.getByRole("tab", { name: /main\.tex/ }));
    await waitFor(() => expect(screen.queryByAltText("Preview of figures/diagram.svg")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: /diagram\.svg/ }));
    expect(await screen.findByAltText("Preview of figures/diagram.svg")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("read_project_file", svgReadAsText);
  });

  it("previews SVG and PDF figures from the Project tree in tabs of their own", async () => {
    const pdf = pdfDocumentStub(1, {
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }), getTextContent: async () => ({ items: [] }),
    });
    mockPdfDocument(() => pdf);
    let pdfRanges = { length: 8, version: "v1" };
    let pdfRemoved = false;
    const removed = () => new Error("That file or folder no longer exists.");
    renderApp({
      ...refreshableProject(projectSnapshot({
        files: [
          dirNode("figures", fileNodes("figures/native-umm.svg", "figures/result.pdf")), fileNode("main.tex"), fileNode("method.md", "text"),
        ],
      })),
      read_project_file: readFiles({ "method.md": "# Method" }, "\\documentclass{article}\n\\begin{document}\n\\end{document}"),
      read_project_asset: (args) => {
        const path = argPath(args);
        if (path.endsWith(".pdf") && pdfRemoved) throw removed();
        return path.endsWith(".pdf")
          ? { path, mimeType: "application/pdf", ranges: pdfRanges }
          : { path, mimeType: "image/svg+xml", base64: "PHN2Zy8+" };
      },
      read_project_asset_range: () => { throw pdfRemoved ? removed() : new Error("This PDF changed on disk."); },
      prepare_latex_figure: "figures/native-umm-converted.pdf", write_project_file: undefined,
      build_project: buildResult(),
    });
    expect(queryProjectTreeItem("figures/native-umm.svg")).toBeNull();
    fireEvent.click(await findProjectTreeItem("figures/"));
    const svgRow = await findProjectTreeItem("figures/native-umm.svg");
    const at10 = { pointerType: "mouse", clientX: 10, clientY: 10 };
    expect(fireEvent.pointerDown(svgRow, { ...at10, button: 0, pointerId: 1 })).toBe(true);
    fireEvent.pointerUp(window, { ...at10, pointerId: 1 });
    fireEvent.click(svgRow);
    expect(await screen.findByAltText("Preview of figures/native-umm.svg")).toHaveAttribute("src", "data:image/svg+xml;base64,PHN2Zy8+");
    const assetTab = screen.getByRole("tab", { name: /native-umm\.svg/ });
    expect(assetTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("figures/native-umm.svg").length).toBeGreaterThanOrEqual(1);
    expect(await findProjectTreeItem("figures/native-umm.svg")).toHaveAttribute("data-item-selected", "true");
    expect(await findProjectTreeItem("main.tex")).not.toHaveAttribute("data-item-selected", "true");

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(assetTab).toHaveAttribute("aria-selected", "false"));
    fireEvent.click(assetTab);
    expect(await screen.findByAltText("Preview of figures/native-umm.svg")).toBeInTheDocument();

    // A figure PDF opens in a reader of its own, not as the project's compiled PDF.
    fireEvent.click(await findProjectTreeItem("figures/result.pdf"));
    expect(await screen.findByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
    const figureReader = (await screen.findByLabelText("PDF page 1")).closest<HTMLElement>(".pdf-preview")!;
    // Read a range at a time from the checked file version, not inlined as base64.
    expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 8 }), disableAutoFetch: true, disableFontFace: true, useSystemFonts: false,
    }));
    expect(within(figureReader).queryByLabelText("Show document outline")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Document view" })).toBeNull();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("prepare_latex_figure", expect.anything());

    // Rewritten on disk while open: the reader moves to the new version by itself.
    pdfRanges = { length: 12, version: "v2" };
    await waitFor(() => expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 12 }),
    })), { timeout: 6_000 });
    expect(screen.getByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");

    // Rewritten again, and a read finds out first: the new version is read at once, not at the next poll.
    const assetReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_project_asset").length;
    const afterPoll = assetReads();
    await waitFor(() => expect(assetReads()).toBeGreaterThan(afterPoll), { timeout: 4_000 });
    const polled = assetReads();
    pdfRanges = { length: 16, version: "v3" };
    const { range } = vi.mocked(getDocument).mock.calls.at(-1)![0] as unknown as {
      range: { requestDataRange(begin: number, end: number): void };
    };
    range.requestDataRange(0, 4);
    await waitFor(() => expect(assetReads()).toBeGreaterThan(polled), { timeout: 1_000 });
    await waitFor(() => expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 16 }),
    })), { timeout: 4_000 });
    expect(formatAppLogs()).not.toContain("changed on disk");

    // Removed outside the app: one notice in the reader, and checks slow down.
    pdfRemoved = true;
    const { range: lastRange } = vi.mocked(getDocument).mock.calls.at(-1)![0] as unknown as {
      range: { requestDataRange(begin: number, end: number): void };
    };
    lastRange.requestDataRange(0, 4);
    // The reader asked moments ago, so this one waits for the next check.
    expect(await screen.findByText("This PDF was removed from the project.", undefined, { timeout: 4_000 }))
      .toHaveAttribute("role", "status");
    expect(screen.getAllByText("This PDF was removed from the project.")).toHaveLength(1);
    const afterRemoval = assetReads();
    await act(() => pause(3_000));
    expect(assetReads()).toBe(afterRemoval);
    expect(screen.getByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
    expect(formatAppLogs()).not.toContain("no longer exists");

    // A rebuild writes it again: the notice clears and the new version opens in the same reader.
    pdfRanges = { length: 20, version: "v4" };
    pdfRemoved = false;
    await waitFor(() => expect(vi.mocked(getDocument)).toHaveBeenCalledWith(expect.objectContaining({
      range: expect.objectContaining({ length: 20 }),
    })), { timeout: 8_000 });
    expect(screen.queryByText("This PDF was removed from the project.")).toBeNull();
    expect(screen.getByRole("tab", { name: /result\.pdf/ })).toHaveAttribute("aria-selected", "true");
  }, 30_000);

  it("keeps the latest file active when an earlier read resolves afterward", async () => {
    setAutoBuildMode("manual");
    const [intro, notes] = [deferred<string>(), deferred<string>()];
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "intro.tex", "notes.tex") })),
      read_project_file: readFiles({ "intro.tex": intro.promise, "notes.tex": notes.promise }, "main"),
    });
    await waitForSelectedTab("main.tex");
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    fireEvent.click(await findProjectTreeItem("notes.tex"));
    await act(async () => { notes.resolve("latest notes"); });
    await waitForSelectedTab("notes.tex");
    await act(async () => { intro.resolve("stale intro"); });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /notes\.tex/ })).toHaveAttribute("aria-selected", "true");
      expect(editorViewAt().state.doc.toString()).toBe("latest notes");
    });
  });

  it.each([
    ["opens a recent project in its own window and leaves this one alone", "Overleaf paper", null, "/tmp/overleaf-paper"],
    ["gives a newly created project its own window when one is already open", "New project", "/tmp", "/tmp/new-paper"],
    ["opens a folder chosen from the picker in its own window too", "Open another folder", "/tmp/other", "/tmp/other"],
  ] as const)("%s", async (_name, menuItem, chosenFolder, path) => {
    setAutoBuildMode("manual");
    if (menuItem === "Overleaf paper") {
      localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
        { name: "Notes", path: "/tmp/notes" }, { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
      ]));
    }
    const notes = notesSnapshot();
    renderApp({
      ...projectCommands(notes, "# Private draft"), create_project: { ...notes, root: "/tmp/new-paper" },
      open_project_window: () => ({ label: "project-1", focusedExisting: false }),
    });
    await expectEditorText("# Private draft");

    vi.mocked(open).mockResolvedValue(chosenFolder);
    await chooseProjectMenuItem(menuItem);
    if (menuItem === "New project") {
      fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "New paper" } });
      fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    }

    await expectInvoked("open_project_window", { path });
    // The point of the feature: this window keeps the project and the buffer it
    // already had, rather than being taken over by the one just opened.
    expect(invoke).not.toHaveBeenCalledWith("open_project", { path });
    expect(editorViewAt().state.doc.toString()).toBe("# Private draft");
  });

  it("does not carry an open Markdown buffer into the next project", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Notes", path: "/tmp/notes" }, { name: "Overleaf paper", path: "/tmp/overleaf-paper" },
    ]));
    const notes = notesSnapshot();
    const overleafSnapshot = projectSnapshot({ root: "/tmp/overleaf-paper", projectId: "overleaf-id", name: "Overleaf paper" });
    let currentRoot = notes.root;
    const incomingPapers = deferred<never[]>();
    renderApp({
      ...projectCommands(notes),
      open_tutorial_project: () => {
        currentRoot = overleafSnapshot.root;
        return overleafSnapshot;
      },
      read_project_file: (args) => readFiles(currentRoot === notes.root
        ? { "draft.md": "# Private draft" } : { "main.tex": "\\documentclass{article}" }, "")(args),
      list_papers: () => currentRoot === overleafSnapshot.root ? incomingPapers.promise : [],
      write_project_file: undefined,
    });
    const initialEditor = await expectEditorText("# Private draft");
    const insertedText = "\nLocal only.";
    const savedCursor = initialEditor.state.doc.length + insertedText.length;
    initialEditor.dispatch({ changes: { from: initialEditor.state.doc.length, insert: insertedText }, selection: { anchor: savedCursor } });

    // Driven through the tutorial, which is one of the flows that still replaces the project in this window.
    // Choosing a project — from the recent list or a folder — now opens a window of its own instead, but every
    // in-place switch still runs this same save/transition/enter path.
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Overleaf paper"));
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    // Long enough for the incoming project's PDF panel to mount and report its first view state, which must
    // not be filed under the outgoing project's file.
    await pause(500);
    expect(invokeCalls("write_project_file")).toEqual([["write_project_file", {
      path: "draft.md", content: "# Private draft\nLocal only.", baseContent: "# Private draft", projectRoot: "/tmp/notes",
    }]]);
    const storedViews = storedFileViews();
    expect(storedViews["/tmp/notes"]?.["draft.md"]?.text).toEqual({ cursor: savedCursor, scrollTop: 0 });
    expect(storedViews["/tmp/overleaf-paper"]?.["draft.md"]).toBeUndefined();

    incomingPapers.resolve([]);
    await expectEditorText("\\documentclass{article}");
  });

  it("does not auto-sync the next project against Overleaf when it is not linked", async () => {
    // Switching away from a linked project has one render where the new root is in but the old link state is not
    // yet cleared; auto-sync firing in that window raised "Sync failed: This project is not linked to an Overleaf
    // project." at the local project.
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.recent-projects.v1", JSON.stringify([
      { name: "Overleaf paper", path: "/tmp/overleaf-paper" }, { name: "Notes", path: "/tmp/notes" },
    ]));
    const overleafSnapshot = projectSnapshot({ root: "/tmp/overleaf-paper", projectId: "overleaf-id", name: "Overleaf paper" });
    const notes = notesSnapshot();
    let currentRoot = overleafSnapshot.root;
    renderApp({
      ...projectCommands(overleafSnapshot),
      open_tutorial_project: () => {
        currentRoot = notes.root;
        return notes;
      },
      refresh_project: () => currentRoot === overleafSnapshot.root ? overleafSnapshot : notes,
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}", "draft.md": "# Local notes" }, ""),
      write_project_file: undefined,
      ...overleafCommands({
        overleaf_link: () => {
          // The backend reads the link off the currently open project; a local project simply has no state file.
          if (currentRoot !== overleafSnapshot.root) throw new Error("This project is not linked to an Overleaf project.");
          return overleafLink({ projectId: "ol-123" });
        },
        overleaf_rt_connect: () => overleafSession({ docs: [] }),
        overleaf_status: () => overleafStatus({ email: "me@example.com", name: "Me" }),
      }),
    });
    // The linked project gets its one-time local/remote check, but neither side
    // moved, so opening it must not start a full project download.
    await expectInvoked("overleaf_probe", { projectRoot: "/tmp/overleaf-paper", checkLocal: true, live: [] });

    // The tutorial is one of the flows that still replaces the project in this
    // window; choosing a project now opens a window of its own instead.
    await chooseProjectMenuItem("Guided tutorial");
    await expectInvoked("open_tutorial_project");
    await expectEditorText("# Local notes");
    // The stale-link window has passed by the time the new project renders;
    // give pending promises a beat and confirm nothing aimed at it.
    await act(async () => { await pause(0); });
    const roots = (command: string) => invokeCalls(command).map(([, args]) => (args as { projectRoot?: string } | undefined)?.projectRoot);
    expect(roots("overleaf_sync")).toEqual([]);
    expect(roots("overleaf_probe")).not.toContain("/tmp/notes");
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
    fireEvent.click(await screen.findByRole("tab", { name: "Changes" }, { timeout: 15_000 }));
    fireEvent.click(await screen.findByRole("button", { name: /Edit main\.tex/i }));
    await screen.findByLabelText("Diff for main.tex");
    fireEvent.click(await screen.findByTitle("Delete this history entry"));
    await waitFor(() => expect(screen.queryByText("Edit main.tex")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("delete_history_entry", { transactionId: "change-1" });
  });

  it("shows the document outline and jumps to a section", async () => {
    type SyncTarget = { page: number; x: number; y: number; width: number; height: number };
    const syncResolvers: Array<(target: SyncTarget) => void> = [];
    renderApp({
      ...projectCommands(projectSnapshot({ files: [fileNode("sections", "folder", { children: [fileNode("sections/introduction.tex")] })] })),
      read_project_file: readFiles(
        { "sections/introduction.tex": "\\subsection{Background}\ntext\n" },
        "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\n\\input{sections/introduction}\n\\section{Results}\n\\end{document}\n",
      ),
      // The outline looks a line up in the PDF's SyncTeX map, so the build writes one.
      build_project: buildResult({ durationMs: 1, hasPdf: true, rootDocument: "main.tex" }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4 outline").buffer,
      synctex_view: () => new Promise((resolve) => syncResolvers.push(resolve)),
    });
    expect(await screen.findByLabelText("Show document outline")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show document outline" }));
    expect(await screen.findByLabelText("Document outline")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Background/i })).toBeInTheDocument();
    expect(screen.queryByText("sections/introduction.tex")).not.toBeInTheDocument();
    expect(screen.queryByText("\\input{sections/introduction.tex}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Results/i }));
    const caretLine = () => {
      const view = editorViewAt();
      return view.state.doc.lineAt(view.state.selection.main.head).number;
    };
    await waitFor(() => expect(caretLine()).toBe(5));
    const editorView = editorViewAt();
    await waitFor(() => expect(syncResolvers).toHaveLength(1));

    // Moving the caret invalidates the outstanding outline-driven SyncTeX
    // response, so it must not install a PDF navigation target.
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    editorView.dispatch({ selection: { anchor: editorView.state.doc.line(3).from } });
    const idsBeforeStaleResponse = randomUUID.mock.calls.length;
    syncResolvers[0]({ page: 1, x: 72, y: 96, width: 120, height: 14 });
    await act(async () => { await Promise.resolve(); });
    expect(randomUUID).toHaveBeenCalledTimes(idsBeforeStaleResponse);

    fireEvent.click(await screen.findByRole("button", { name: "Show document outline" }));
    fireEvent.click(await screen.findByRole("button", { name: /Results/i }));
    await waitFor(() => expect(syncResolvers).toHaveLength(2));
    await waitFor(() => expect(caretLine()).toBe(5));
    const idsBeforeLatestResponse = randomUUID.mock.calls.length;
    syncResolvers[1]({ page: 2, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(randomUUID).toHaveBeenCalledTimes(idsBeforeLatestResponse + 1));
  });

  it("opens the document before its label index lands, and checks it only against that index", async () => {
    const citations = deferred<unknown[]>();
    const references = deferred<unknown[]>();
    renderApp({
      ...projectCommands(projectSnapshot(), "See \\cite{known}, \\ref{fig:model} and \\ref{fig:gone}."),
      list_citations: () => citations.promise,
      list_references: () => references.promise,
    });
    const view = await expectEditorText("See \\cite{known}, \\ref{fig:model} and \\ref{fig:gone}.");
    const diagnostics = () => {
      const found: string[] = [];
      forEachDiagnostic(view.state, (diagnostic) => found.push(diagnostic.message));
      return found;
    };
    // Past the linter's delay: an index that is not this project's yet reports nothing.
    await pause(600);
    expect(diagnostics()).toEqual([]);

    citations.resolve([{ key: "known", title: "", authors: "", year: "", venue: "" }]);
    references.resolve([{ label: "fig:model", kind: "figure", title: "", snippet: "", path: "sections/a.tex", line: 1 }]);
    await waitFor(() => expect(diagnostics()).toEqual(["Unknown label “fig:gone”."]));
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

  it.each([
    ["board", "sketch", "sketch.tldr", "board-editor-mock"],
    ["spreadsheet", "results", "results.lattice-sheet", "spreadsheet-editor-mock"],
  ])("creates a %s from the header button with an inline name", async (kind, name, path, editor) => {
    renderApp({ ...refreshableProject(projectSnapshot({ files: [fileNode("notes.tex")] }), ""), create_project_entry: (args) => argPath(args) });
    await screen.findByLabelText("Project files");
    await chooseNewDocument(`New ${kind}`);
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput).toHaveValue("untitled");
    fireEvent.input(nameInput, { target: { value: name } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await expectInvoked("create_project_entry", { path, kind: "file", projectRoot: ROOT });
    expect(await screen.findByTestId(editor)).toBeInTheDocument();
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

  it("creates and opens a native Open Slide presentation", { timeout: 30000 }, async () => {
    await import("../project/project-file-tree");
    renderApp({
      ...refreshableProject(projectSnapshot(), "export default [];\n"),
      create_open_slide_deck: (args) => `slides/${(args as { deckId: string }).deckId}/index.tsx`,
    });
    await waitFor(() => expect(projectTreeRoot()).not.toBeNull(), { timeout: 15000 });
    await chooseNewDocument("New presentation");
    const nameInput = await findProjectTreeRenameInput();
    expect(nameInput.closest("[data-item-path]")).toHaveAttribute("data-item-path", "slides/untitled/");
    fireEvent.input(nameInput, { target: { value: "quarterly-review" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    await expectInvoked("create_open_slide_deck", { deckId: "quarterly-review", projectRoot: ROOT });
    expect(await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15000 }))
      .toHaveAttribute("data-path", "slides/quarterly-review/index.tsx");
  });

  it("defers an active Open Slide Overleaf sync until the document is left", { timeout: 120_000 }, async () => {
    localStorage.setItem("lattice.last-file.v1", JSON.stringify({ "/tmp/lattice-slide-overleaf": "slides/native/index.tsx" }));
    const deck = "slides/native/index.tsx";
    const deckSource = "export default [{ id: 'title' }];\n";
    const editedDeckSource = "export default [{ id: 'title', title: 'Edited' }];\n";
    let probeChanged = true;
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-slide-overleaf", projectId: "slide-overleaf-id", name: "Slide Overleaf", files: fileNodes("main.tex", deck),
    });
    renderOverleafPaper({
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}\n" }, deckSource),
      write_project_file: (args) => ({ content: String((args as { content?: string } | undefined)?.content ?? ""), hadConflicts: false }),
      overleaf_link: () => overleafLink({ projectId: "ol-slide", projectName: "Slide Overleaf" }),
      overleaf_probe: () => overleafProbe({ changed: probeChanged, remoteVersion: 12 }),
      overleaf_sync: () => overleafSyncResult({ pushed: [deck] }),
      overleaf_rt_connect: () => overleafSession({ docs: [] }),
    }, { snapshot, syncMode: "live" });
    expect(await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 60_000 })).toHaveAttribute("data-path", deck);
    const diagnosticContext = { operation_id: expect.any(String), request_id: expect.any(String) };
    await expectInvoked("overleaf_probe", { projectRoot: snapshot.root, checkLocal: true, live: [deck] });
    await expectInvoked("overleaf_sync", { projectRoot: snapshot.root, live: [deck], observedRemoteVersion: 12, diagnosticContext });
    probeChanged = false;
    const syncCountBeforeMutation = invokeCalls("overleaf_sync").length;

    await act(async () => {
      await openSlideWorkspaceApi.onMutation!({ id: 17, path: deck, kind: "write", text: editedDeckSource, previousText: deckSource });
    });
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: deck, content: editedDeckSource, baseContent: deckSource, projectRoot: snapshot.root,
    });
    await act(async () => { await pause(1_200); });
    expect(invokeCalls("overleaf_sync")).toHaveLength(syncCountBeforeMutation);

    fireEvent.click(await findProjectTreeItem("main.tex"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("overleaf_sync", {
      projectRoot: snapshot.root, live: [], observedRemoteVersion: null, diagnosticContext,
    }), { timeout: 5000 });
  });

  it("accepts an Open Slide delete when the canonical asset is already gone", { timeout: 20000 }, async () => {
    renderApp({
      ...refreshableProject(projectSnapshot({ rootDocuments: [], files: [fileNode("slides/native/index.tsx")] }), "export default [];\n"),
      delete_project_entry: () => { throw new Error("That file or folder no longer exists."); },
      stat_project_file: () => ({ exists: false, mtimeMs: 0 }),
    });
    await screen.findByTestId("open-slide-workspace-mock", {}, { timeout: 15000 });
    let operations: OpenSlideSyncOperation[] = [];
    await act(async () => {
      operations = await openSlideWorkspaceApi.onMutation!({ id: 9, path: "assets/unused.png", kind: "delete" });
    });
    expect(invoke).toHaveBeenCalledWith("delete_project_entry", { path: "assets/unused.png", projectRoot: ROOT });
    expect(invoke).toHaveBeenCalledWith("stat_project_file", { path: "assets/unused.png" });
    expect(operations).toEqual([{ path: "assets/unused.png", kind: "delete" }]);
    expect(formatAppLogs()).not.toContain("That file or folder no longer exists.");
  });

  it("lets the Agent create and open a board or spreadsheet through the host bridge", async () => {
    renderApp({ ...refreshableProject(projectSnapshot(), ""), create_project_entry: (args) => argPath(args) });
    const { frame, postMessage } = await openAgentFrame();
    const createThroughAgent = async (id: string, path: string, documentType: string) => {
      postWindowMessage(frame.contentWindow, {
        type: "synara:project-document-tool-request", version: 1, id, args: { path, documentType }, expiresAt: Date.now() + 10_000,
      });
      await waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: "lattice:project-document-tool-result", id, ok: true, result: { path, documentType, opened: true },
      }), synaraHook.runtime.origin));
    };
    const unregisterBoard = registerAgentCanvasAdapter("agent-board.tldr", { execute: () => ({}) });
    await createThroughAgent("create-board", "agent-board.tldr", "board");
    expect(invoke).toHaveBeenCalledWith("create_project_entry", { path: "agent-board.tldr", kind: "file", projectRoot: ROOT });
    expect(await screen.findByTestId("board-editor-mock")).toBeInTheDocument();
    unregisterBoard();
    const spreadsheetDoc = new Y.Doc();
    const unregisterSpreadsheet = registerAgentSpreadsheetDocument("agent-data.lattice-sheet", { doc: spreadsheetDoc, canWrite: true });
    await createThroughAgent("create-spreadsheet", "agent-data.lattice-sheet", "spreadsheet");
    expect(await screen.findByTestId("spreadsheet-editor-mock")).toBeInTheDocument();
    unregisterSpreadsheet();
    spreadsheetDoc.destroy();
  });
});
