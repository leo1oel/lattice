import { windowApi, synaraHook, chooseLayoutPreset, fileNode, projectCommands, attentionPaper, projectSnapshot, buildResult, deferred, type Deferred, setAutoBuildMode, selectPanelTab, buildButton, waitForBuildIdle, findFrame, postWindowMessage, expectInvoked, invokeCalls, pause, persistLayoutWithoutAgent, argPath, openAgentFrame, postProjectHistory, chooseProjectMenuItem, findSettingsDialog, interfaceSounds, pdfSlickTestApi, tauriEventApi, emitTauriEvent, fileNodes, dirNode, refreshableProject, ROOT, rootDocument, MAIN_DOCUMENT, markdownSnapshot, failedBuild, readFiles, selectDocumentView, findProjectTreeItem, expectNotification, editorViewAt, findEditorView, appendToEditor, expectEditorText, persistLayout, waitForSelectedTab, openTreeFile, visibleToasts, pdfDocumentStub, mockPdfDocument, stubObjectUrls, queryProjectTreeItem, nextFrames, visualEditorOf, stubScrollBox, overleafLink, overleafStatus, overleafProbe, overleafSyncResult, overleafSession, OVERLEAF_EMPTY_FEEDS, overleafCommands, overleafPaperSnapshot, openPaper, findOverleafSyncButton, openSlideWorkspaceApi, browserRuntime, SINGLE_TRANSFORMER, notesSnapshot, projectTreeRoot, findProjectTreeRenameInput, findElement, stubElementFromPoint, storedFileViews, dropFinderPaths, dragTreeItem, chooseNewDocument, fileHit, expandDirectories } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { PRODUCTION_SURFACES } from "./production-surfaces";
// Warm the canvas and the PDF panel as their own suites do; Settings stays cold, as the Settings suites keep it.
import "./app-test-canvas";
import "./app-test-pdf-panel";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, screen, waitFor, within, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { completionStatus, insertBracket, selectedCompletionIndex } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getDocument } from "pdfjs-dist";
import { formatAppLogs, getAppToastOptions } from "../telemetry/app-log-store";
import { loadTextLanguageExtensions } from "../editor/editor-languages";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";
import * as Y from "yjs";
import { registerAgentCanvasAdapter } from "../agent/agent-canvas-tools";
import { registerAgentSpreadsheetDocument } from "../agent/agent-spreadsheet-tools";
import type { OpenSlideSyncOperation } from "../editor/presentation/open-slide-bridge";
import type { LayoutDocument } from "@danfessler/trellis";

/**
 * The App assembly with every production surface: the behavior that crosses surfaces — a build that reads the
 * editor, a project flow that lands in the canvas, Settings opened from the Agent — which no single feature
 * suite mounts. It runs for any change App reaches; the feature suites (`app-documents`, `app-builds`, …)
 * mount one real surface each and doubles for the rest. Each block keeps the describe of the suite it came
 * from.
 */
const { renderApp, renderOverleafPaper, openWithAutomaticBuilds } = appHarness(PRODUCTION_SURFACES);

// The PDF viewer, counting its renders.
const pdfPreviewRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../pdf/pdf-viewer", async (importOriginal) => {
  const viewer = await importOriginal<typeof import("../pdf/pdf-viewer")>();
  return {
    ...viewer,
    PdfPreview: (props: ComponentProps<typeof viewer.PdfPreview>) => {
      pdfPreviewRenders.count += 1;
      return createElement(viewer.PdfPreview, props);
    },
  };
});

// The Agent with Settings and the canvas.
describe("Agent panel", () => {
  it("shows Synara failure states without rendering the retired Agent settings or composer", async () => {
    // Keep both lazy surfaces' cold transforms outside DOM query deadlines.
    await Promise.all([import("../trellis/trellis-agent-surface"), import("../settings/settings-dialog")]);
    synaraHook.runtime = {
      state: "stopped", origin: null, authToken: null, message: "Synara did not start.", startupMs: null, version: null, revision: null,
    };
    renderApp(projectCommands());
    await selectPanelTab("Agent");
    const agentFailure = await screen.findByRole("alert");
    expect(agentFailure).toBeVisible();
    expect(agentFailure).toHaveTextContent("Agent unavailable");
    expect(agentFailure).toHaveTextContent("Synara did not start.");
    expect(screen.queryByPlaceholderText(/ask the agent/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Conversation history")).not.toBeInTheDocument();
    await chooseProjectMenuItem("Settings");
    const settings = await findSettingsDialog();
    fireEvent.click(within(settings).getByRole("button", { name: "Providers" }));
    await waitFor(() => expect(within(settings).getByRole("alert")).toHaveTextContent("Agent unavailable"));
    expect(within(settings).queryByLabelText("Agent system prompt")).not.toBeInTheDocument();
    expect(within(settings).queryByText("Subscriptions")).not.toBeInTheDocument();
  });

  it("restores the Agent's saved thread and follows only its own frame", async () => {
    // Finish cold compilation before DOM waits and unmount/remount assertions.
    await Promise.all([import("../settings/settings-dialog"), import("../canvas/document-canvas")]);
    localStorage.setItem("lattice.agent-thread.v1:/tmp/lattice-paper", "saved-thread");

    const view = renderApp(projectCommands());
    await selectPanelTab("Agent");
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(synaraHook.enabledCalls).toContain(true));
    const frame = await findFrame();
    expect(new URL(frame.src).pathname).toBe("/saved-thread");
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);
    expect(postMessage).not.toHaveBeenCalled();
    expect(frame.closest(".synara-frame-shell")).not.toHaveAttribute("data-ready");

    postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });

    await waitFor(() => expect(frame.closest(".synara-frame-shell")).toHaveAttribute("data-ready"));
    expect(postMessage).toHaveBeenCalledWith({ type: "lattice:request-agent-permission-mode" }, synaraHook.runtime.origin);

    postProjectHistory(frame, "wrong-thread", [], "https://untrusted.example");
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("saved-thread");
    postProjectHistory(frame, "selected-thread", []);
    expect(localStorage.getItem("lattice.agent-thread.v1:/tmp/lattice-paper")).toBe("selected-thread");
    // Recording navigation must not reload the live iframe or interrupt a turn.
    expect(new URL(frame.src).pathname).toBe("/saved-thread");

    const openSettings = { type: "synara:open-settings", section: "providers" };
    postWindowMessage(frame.contentWindow, openSettings, "https://untrusted.example");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    postWindowMessage(frame.contentWindow, openSettings);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(settings).getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");
    view.unmount();
    renderApp();
    await waitFor(() => {
      const restored = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(restored).not.toBeNull();
      expect(new URL(restored!.src).pathname).toBe("/selected-thread");
    });
  });

  it("routes agent paper, file, link, and review requests to their native surfaces", async () => {
    const sections = fileNode("sections", "folder", { children: [fileNode("sections/intro.tex")] });
    const snapshot = projectSnapshot({ files: [fileNode("main.tex"), sections] });
    renderApp({
      ...projectCommands(snapshot),
      read_project_file: (args) => {
        if (!argPath(args)?.endsWith(".png")) return "\\documentclass{article}";
        throw new Error("This is a binary or unsupported file and cannot be opened in the source editor.");
      },
      read_project_asset: (args) => ({ path: argPath(args), mimeType: "image/png", base64: "iVBORw0KGgo=" }),
      stat_project_file: () => ({ exists: true, mtimeMs: 1 }),
      list_papers: () => [attentionPaper({ authors: "Ashish Vaswani and Noam Shazeer", hasBlog: false })],
      read_paper: "---\ntitle: Attention Is All You Need\n---\n\n## Abstract\n\nPaper content.", read_paper_blog_local: null,
      build_project: buildResult({ durationMs: 5, rootDocument: "/private/outside/main.tex" }),
    });
    await screen.findByRole("button", { name: "Switch project" });
    await screen.findByTitle("Attention Is All You Need");
    const { frame } = await openAgentFrame();

    const agent = (data: object) => postWindowMessage(frame.contentWindow, data);
    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/notes/detailed%20distillation.md" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "notes/detailed distillation.md" }));

    agent({ type: "synara:open-external", url: "https://example.com/paper" });
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.com/paper"));

    agent({ type: "synara:open-external", url: "javascript:alert(1)" });
    expect(openUrl).toHaveBeenCalledTimes(1);

    agent({ type: "synara:open-file", filePath: "/tmp/lattice-paper/.research/papers/1706.03762/paper.md" });
    expect(await screen.findByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: "1706.03762" });

    agent({ type: "synara:open-review", filePath: "sections/intro.tex" });
    await expectInvoked("read_project_file", expect.objectContaining({ path: "sections/intro.tex" }));
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();

    const figure = "figures/mmvp_prefix_suffix_retained_pair_accuracy_plotly.png";
    agent({ type: "synara:open-review", filePath: figure });
    expect(await screen.findByAltText(`Preview of ${figure}`)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("read_project_asset", { path: figure });

    agent({ type: "synara:open-review", threadId: "thread-1", turnId: "turn-9" });
    expect(await screen.findByRole("tab", { name: "Agent turn" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Git workspace" })).toHaveClass("drawer-view-tabs");
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveClass("drawer-view-tab");
    expect(screen.getByRole("tab", { name: "Changes" })).not.toHaveClass("ui-compact-selectable");
    const reviewFrame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent turn review"]');
    expect(reviewFrame).not.toBeNull();
    expect(reviewFrame!.src).toContain("threadId=thread-1");
    expect(reviewFrame!.src).toContain("turnId=turn-9");

    // Tabbing back to the working tree drops the pinned turn.
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Agent turn" })).not.toBeInTheDocument());
    expect(document.querySelector('iframe[title="Changes"]')).not.toBeNull();
  });
});

// Builds with the editor they save, read and navigate.
describe("builds and the PDF reader", () => {
  it("automatically builds after 1.2 seconds without editing", async () => {
    await openWithAutomaticBuilds({ write_project_file: undefined });
    const view = await findEditorView();
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nIdle build." } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nIdle build.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    }), { timeout: 2_500 });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

  it.each(["completion selection", "PDF pointer down", "PDF wheel"])("resumes autosave after citation completion on %s", async (trigger) => {
    await openWithAutomaticBuilds({
      list_citations: () => ["dosovitskiy2021image", "vaswani2017attention"].map((key) => ({ key, title: "", authors: "", year: "", venue: "" })),
      write_project_file: undefined,
    }, projectSnapshot());
    const view = await waitFor(() => editorViewAt(), { timeout: 60_000 });

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    for (const character of "\nSee \\cite") {
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: character },
        selection: { anchor: range.from + character.length },
        annotations: Transaction.userEvent.of("input.type"),
      });
    }
    const openingBrace = new KeyboardEvent("keydown", { key: "{", code: "BracketLeft", shiftKey: true, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(openingBrace);
    if (!openingBrace.defaultPrevented) {
      const transaction = insertBracket(view.state, "{");
      if (transaction) view.dispatch(transaction);
    }
    expect(view.state.doc.toString()).toContain("\\cite{}");
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    await act(() => pause(1_400));
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "build_project")).toBe(false);

    if (trigger !== "completion selection") {
      const pdf = document.querySelector(".pdf-column")!;
      if (trigger === "PDF pointer down") fireEvent.pointerDown(pdf);
      else fireEvent.wheel(pdf, { deltaY: 120 });
      await expectInvoked("write_project_file", {
        path: "main.tex", content: "\\documentclass{article}\nSee \\cite{}", baseContent: "\\documentclass{article}", projectRoot: ROOT,
      });
      expect(completionStatus(view.state)).toBeNull();
      return;
    }

    expect(selectedCompletionIndex(view.state)).toBe(0);
    fireEvent.keyDown(view.contentDOM, { key: "ArrowDown", code: "ArrowDown" });
    expect(selectedCompletionIndex(view.state)).toBe(1);
    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
    expect(view.state.doc.toString()).toContain("\\cite{vaswani2017attention}");
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT })), { timeout: 2_500 });
  }, 90_000);

  it("does not mistake a disk read started before autosave for a new external edit", async () => {
    const original = "\\documentclass{article}";
    let disk = original;
    let mtimeMs = 1;
    let holdRead = false;
    let finishRead: (() => void) | undefined;
    await openWithAutomaticBuilds({
      read_project_file: () => {
        if (!holdRead) return disk;
        holdRead = false;
        const captured = disk;
        return new Promise<string>((resolve) => { finishRead = () => resolve(captured); });
      },
      stat_project_file: () => ({ exists: true, mtimeMs }),
      write_project_file: (args) => {
        disk = (args as { content: string }).content;
        mtimeMs += 1;
        return { content: disk, hadConflicts: false };
      },
    });
    const view = await expectEditorText(original);
    holdRead = true;
    mtimeMs += 1;
    await waitFor(() => expect(finishRead).toBeTypeOf("function"), { timeout: 3_500 });
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n我的新修改" } }));
    const expected = `${original}\n我的新修改`;
    await waitFor(() => expect(disk).toBe(expected), { timeout: 2_500 });
    await waitForBuildIdle();
    await act(async () => {
      finishRead!();
      await pause(300);
    });
    expect(view.state.doc.toString()).toBe(expected);
    expect(disk).toBe(expected);
  });

  it("accepts an agent edit in an open Markdown preview and still switches files", async () => {
    persistLayout(ROOT, { openTabs: ["methods.md", "notes.md"], activeFile: "methods.md", canvasMode: "pdf" });
    const sources: Record<string, string> = { "methods.md": "## Scope\n- **Measures**: Initial result\n", "notes.md": "# Notes" };
    let mtimeMs = 1;
    renderApp({
      ...refreshableProject(projectSnapshot({
        rootDocuments: rootDocument("methods.md", "Methods"), files: fileNodes("methods.md", "notes.md"),
      })),
      read_project_file: readFiles(sources, ""), stat_project_file: () => ({ exists: true, mtimeMs }), write_project_file: undefined,
    });
    const visualEditor = () => screen.getByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(visualEditor()).toHaveTextContent("Initial result"));
    sources["methods.md"] = "## Scope\n- **Measures**: Agent revision\n";
    mtimeMs = 2;
    await waitFor(() => expect(visualEditor()).toHaveTextContent("Agent revision"), { timeout: 4_000 });
    expect(screen.queryByText("This document changed in the same place")).not.toBeInTheDocument();
    await openTreeFile("notes.md");
  });

  it("preserves an external Markdown blank-line edit through the next save and poll", async () => {
    persistLayout(ROOT, { openTabs: ["notes.md"], activeFile: "notes.md", canvasMode: "split" });
    let source = "# Notes\nParagraph\n";
    let mtimeMs = 1;

    await Promise.all([loadTextLanguageExtensions("notes.md"), loadVisualMarkdownEditorModule()]);
    renderApp({
      ...refreshableProject(markdownSnapshot()), read_project_file: () => source, stat_project_file: () => ({ exists: true, mtimeMs }),
      write_project_file: (args) => {
        source = (args as { content: string }).content;
        mtimeMs += 1;
      },
    });
    await screen.findByRole("tablist", { name: "Document view" });
    selectDocumentView("Split");
    const view = await expectEditorText(source, ".source-editor .cm-editor", { timeout: 10_000 });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stat_project_file", { path: "notes.md" }), { timeout: 3_500 });

    const externalSource = "# Notes\n\nParagraph\n";
    source = externalSource;
    mtimeMs = 2;
    await waitFor(() => expect(view.state.doc.toString()).toBe(externalSource), { timeout: 3_500 });
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    const statCallsAfterExternalEdit = invokeCalls("stat_project_file").length;
    await waitFor(() => expect(invokeCalls("stat_project_file").length).toBeGreaterThan(statCallsAfterExternalEdit), { timeout: 3_500 });
    expect(invoke).not.toHaveBeenCalledWith("write_project_file", expect.anything());
    expect(source).toBe(externalSource);
    expect(view.state.doc.toString()).toBe(externalSource);
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "More.\n" } }));
    fireEvent.pointerLeave(document.querySelector(".source-editor")!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({
      path: "notes.md", content: `${externalSource}More.\n`,
    })), { timeout: 3_500 });
    expect(source).toBe(`${externalSource}More.\n`);
  }, 60_000);

  it("renders every PDF page in one continuous themed reader", async () => {
    const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
    const renderPdfPage = vi.fn(() => renderTask);
    const getPdfPageText = vi.fn(async () => ({ items: [{ str: "Attention is all you need" }] }));
    const pdf = pdfDocumentStub(2, {
      render: renderPdfPage,
      getTextContent: getPdfPageText,
      getAnnotations: async () => [{ id: "link-1", subtype: "Link", rect: [10, 20, 80, 40], url: "https://example.com/paper" }],
    });
    mockPdfDocument(() => pdf);
    let pdfUrlSequence = 0;
    stubObjectUrls(() => `blob:lattice-pdf-${++pdfUrlSequence}`);
    vi.mocked(save).mockResolvedValue("/tmp/exported-paper.pdf");
    let forwardSyncFailure: string | null = null;
    let reverseSyncTarget: { path: string; line: number } = { path: "main.tex", line: 1 };
    let delayForwardSync = false;
    let resolveForwardSync!: (target: { page: number; x: number; y: number; width: number; height: number }) => void;
    renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), build_project: buildResult({ hasPdf: true, durationMs: 100 }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      save_compiled_pdf: "/tmp/exported-paper.pdf", synctex_edit: () => reverseSyncTarget,
      synctex_view: (args) => {
        const syncArgs = args as Record<string, unknown> | undefined;
        if (delayForwardSync && syncArgs?.path === "main.tex") {
          delayForwardSync = false;
          return new Promise((resolve) => { resolveForwardSync = resolve; });
        }
        if (forwardSyncFailure && syncArgs?.path === "main.tex" && syncArgs?.line === 1) throw new Error(forwardSyncFailure);
        return { page: 1, x: 72, y: 96, width: 120, height: 14 };
      },
    });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
    await expectInvoked("read_compiled_pdf", { projectRoot: ROOT });
    // The production PDF viewer is a heavy lazy chunk. Let Vitest transform it
    // before asserting on PDFSlick's document source.
    await waitFor(() => expect(document.querySelector(".pdf-preview")).not.toBeNull(), { timeout: 30_000 });
    await waitFor(() => expect(pdfSlickTestApi.sources.map((source) => (
      typeof source === "string" ? source : `${source.constructor.name}:${source.byteLength}`
    ))).toContain("ArrayBuffer:8"), { timeout: 5_000 });
    const savePdf = await screen.findByRole("button", { name: "Save PDF as…" });
    expect(document.querySelector(".pdf-scroll-area [data-slot='scroll-area-viewport']")).not.toHaveClass("scroll-fade-both");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    expect(await screen.findByLabelText("PDF page 1")).toBeInTheDocument();
    expect(await screen.findByLabelText("PDF page 2")).toBeInTheDocument();
    // PDFSlick owns the virtualized render queue and paints each visible page
    // directly at its output scale rather than replacing a blurry preview.
    await waitFor(() => expect(renderPdfPage).toHaveBeenCalledTimes(2));
    expect(renderTask.cancel).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector(".pdf-text-layer span")).toHaveTextContent("Attention is all you need"));
    expect(getPdfPageText).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByTitle("https://example.com/paper").length).toBeGreaterThan(0));
    expect(pdf.getPage).toHaveBeenCalledWith(1);
    await waitFor(() => expect(pdf.getPage).toHaveBeenCalledWith(2));
    for (const name of ["Zoom out", "Zoom in"]) expect(screen.getByRole("button", { name })).toBeInTheDocument();
    const fitWidth = screen.getByRole("button", { name: "Fit page to width" });
    const fitHeight = screen.getByRole("button", { name: "Fit page to height" });
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(fitHeight);
    expect(fitWidth).toHaveAttribute("aria-pressed", "false");
    expect(fitHeight).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(localStorage.getItem("lattice.pdf-view-preference.v1")).toContain('"fitMode":"height"'));
    fireEvent.click(fitHeight);
    expect(fitHeight).toHaveAttribute("aria-pressed", "false");
    const pageInput = screen.getByLabelText("PDF page number");
    fireEvent.focus(pageInput);
    fireEvent.change(pageInput, { target: { value: "2" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });
    expect(pageInput).toHaveValue("2");
    const searchInput = screen.getByLabelText("Search PDF");
    const searchIcon = () => searchInput.closest(".pdf-search")!.querySelector(":scope > svg");
    expect(searchIcon()).not.toBeNull();
    fireEvent.change(searchInput, { target: { value: "attention" } });
    expect(searchIcon()).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(getPdfPageText).not.toHaveBeenCalled();
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next search result" }));
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll(".pdf-text-layer .highlight").length).toBe(2);
      expect(document.querySelectorAll(".pdf-text-layer .highlight.selected").length).toBe(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear PDF search" }));
    expect(searchInput).toHaveValue("");
    expect(searchIcon()).not.toBeNull();
    const revealCursor = screen.getByRole("button", { name: /Reveal cursor in PDF/i });
    const pdfZoomControls = fitWidth.closest(".pdf-zoom-controls");
    expect(pdfZoomControls).toContainElement(revealCursor);
    expect(pdfZoomControls?.querySelectorAll(".pdf-fit-divider")).toHaveLength(2);
    const pdfButtons = Array.from(pdfZoomControls!.querySelectorAll<HTMLElement>("button"));
    expect(pdfButtons.indexOf(revealCursor)).toBeLessThan(pdfButtons.indexOf(fitWidth));
    const editorView = editorViewAt(".source-editor .cm-editor");
    let revealReconfigurations = 0;
    editorView.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of((update) => {
        for (const transaction of update.transactions) {
          revealReconfigurations += transaction.effects.filter((effect) => effect.is(StateEffect.reconfigure)).length;
        }
      })),
    });
    expect(fireEvent.mouseDown(revealCursor)).toBe(false);
    delayForwardSync = true;
    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 1, column: 0 });
    editorView.dispatch({ selection: { anchor: 5 } });
    resolveForwardSync({ page: 1, x: 72, y: 96, width: 120, height: 14 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    expect(screen.queryByLabelText("Source location in PDF")).not.toBeInTheDocument();

    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 1, column: 5 });
    expect(await screen.findByLabelText("Source location in PDF")).toBeInTheDocument();
    expect(revealReconfigurations).toBe(0);
    await waitFor(() => expect(revealCursor).toBeEnabled());
    forwardSyncFailure = "This bibliography entry is not included in the compiled PDF.";
    fireEvent.click(revealCursor);
    // A failed reverse-sync is a warning, not an error: the click did nothing,
    // but nothing broke either. `app-log.test.tsx` covers how it is drawn.
    await expectNotification(new RegExp(`\\[WARNING\\].*\\n?.*${forwardSyncFailure.replace(/[.]/g, "\\.")}`));
    expect(formatAppLogs()).not.toMatch(/\[ERROR\]/);
    expect(revealReconfigurations).toBe(0);
    forwardSyncFailure = null;
    const zoomInput = screen.getByLabelText("PDF zoom percentage") as HTMLInputElement;
    fireEvent.click(fitWidth);
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    const fitZoom = Number(zoomInput.value);
    fireEvent.wheel(zoomInput.parentElement!, { deltaY: -1 });
    expect(zoomInput).toHaveValue(String(fitZoom + 10));
    expect(fitWidth).toHaveAttribute("aria-pressed", "false");
    const zoomBefore = Number(zoomInput.value);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomInput).toHaveValue(String(zoomBefore + 10));
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    interfaceSounds.play.mockClear();
    fireEvent.click(buildButton());
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("success"));
    // Identical PDF bytes must not thrash pdf.js — keep the same document + zoom.
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
    expect(zoomInput).toHaveValue(String(zoomBefore + 10));
    fireEvent.click(savePdf);
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "paper.pdf" })));
    await expectInvoked("save_compiled_pdf", expect.objectContaining({ byteLength: 8 }), {
      headers: { "x-pdf-destination": "L3RtcC9leHBvcnRlZC1wYXBlci5wZGY=" },
    });
    await expectNotification(/Saved to \/tmp\/exported-paper\.pdf/);
    // Double-click (not single click) jumps from the PDF back to the source.
    fireEvent.doubleClick(screen.getByLabelText("PDF page 1"), { clientX: 110, clientY: 220 });
    await expectInvoked("synctex_edit", { page: 1, x: 91.667, y: 183.333 });
    // A citation resolves into the bibliography, which has no preview of its
    // own. The jump must not close the PDF it was made from.
    reverseSyncTarget = { path: "references.bib", line: 4 };
    fireEvent.doubleClick(screen.getByLabelText("PDF page 1"), { clientX: 110, clientY: 220 });
    await expectInvoked("read_project_file", { path: "references.bib", projectRoot: ROOT });
    // Still the same viewer instance, at the page the jump was made from: the
    // preview column follows the project's build, not the file in the editor.
    expect(screen.getByLabelText("PDF page 1")).toBeInTheDocument();
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);

    // An included TeX file is also part of this build, not a new PDF. The first
    // reverse jump must move the editor without resetting the reader's place.
    const pageBeforeJump = screen.getByLabelText("PDF page 2");
    const viewportBeforeJump = pageBeforeJump.closest<HTMLElement>(".pdf-scroll-area-viewport")!;
    viewportBeforeJump.scrollTop = 950;
    reverseSyncTarget = { path: "chapters/results.tex", line: 1 };
    fireEvent.doubleClick(pageBeforeJump, { clientX: 110, clientY: 220 });
    await waitForSelectedTab("results.tex");
    expect(screen.getByLabelText("PDF page 2")).toBe(pageBeforeJump);
    expect(viewportBeforeJump.scrollTop).toBe(950);
    expect(vi.mocked(getDocument)).toHaveBeenCalledTimes(1);
  });

  it("opens a compile repair in the Agent panel without replacing its frame", async () => {
    await Promise.all([import("../build/compile-diagnostics-panel"), import("../canvas/document-canvas"), import("../trellis/trellis-agent-surface")]);
    renderApp({
      ...projectCommands(projectSnapshot({
        root: "/tmp/repair-placement", projectId: "repair-placement", name: "Repair placement", rootDocuments: MAIN_DOCUMENT,
      })),
      build_project: buildResult({
        durationMs: 1, rootDocument: "main.tex",
        diagnostics: [{ file: "main.tex", line: 1, level: "warning", message: "Undefined reference." }],
      }),
      compile_repair: (args) => (args as { action: string }).action === "start"
        ? { threadId: "repair-placement-task" } : { status: "running" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 warning/i }));
    // The Agent waits as a tab behind Project, its frame already live.
    const originalFrame = await findFrame();
    expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(await screen.findByRole("button", { name: "Fix all" }));
    fireEvent.click(await screen.findByRole("button", { name: "View repair" }));
    await waitFor(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Agent"]');
      expect(frame).toBe(originalFrame);
      expect(new URL(frame!.src).pathname).toBe("/repair-placement-task");
      expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute("aria-selected", "true");
    });
  });

  it("repairs all compile errors and warnings with panel permissions and reloads before recompiling", async () => {
    await import("../build/compile-diagnostics-panel");
    await import("../canvas/document-canvas");
    let repaired = false;
    const warning = { file: "main.tex", line: 3, level: "warning", message: "Reference `old-label' undefined." };
    const error = { file: "main.tex", line: 9, level: "error", message: "Undefined control sequence." };
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-repair", projectId: "repair-paper", name: "Repair paper", rootDocuments: MAIN_DOCUMENT,
    });
    renderApp({
      ...refreshableProject(snapshot),
      read_project_file: () => `\\documentclass{article}\n\\begin{document}\n${repaired ? "Fixed reference" : "\\ref{old-label}"}\n\\end{document}`,
      build_project: () => buildResult({
        durationMs: 10, rootDocument: "main.tex", log: repaired ? "" : warning.message, diagnostics: repaired ? [] : [warning, error],
      })(),
      compile_repair: (args) => {
        if ((args as { action: string }).action === "start") return { threadId: "repair-task" };
        repaired = true;
        return { status: "completed" };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /1 warning/i }));
    const fix = await screen.findByRole("button", { name: "Fix all" });
    await waitFor(() => expect(fix).toBeEnabled());
    const previousBuilds = invokeCalls("build_project").length;
    fireEvent.click(fix);
    await expectInvoked("compile_repair", {
      action: "start", projectRoot: snapshot.root, rootDocument: "main.tex", diagnostics: [warning, error], runtimeMode: "full-access",
    });
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(previousBuilds + 1));
    await waitFor(() => expect(screen.getByText("Repair finished")).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".cm-content")).toHaveTextContent("Fixed reference"));
    expect(screen.queryByText(warning.message)).not.toBeInTheDocument();
  });

  it("lists successful-build diagnostics and jumps to the reported source line", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: [fileNode("main.tex"), dirNode("chapters", [fileNode("chapters/intro.tex")])] })),
      read_project_file: readFiles({
        "main.tex": "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n",
        "chapters/intro.tex": "\\section{Intro}\none\ntwo\nthree\nfour\n",
      }, ""),
      build_project: buildResult({
        log: "chapters/intro.tex:4: Overfull hbox.\n", durationMs: 80,
        diagnostics: [{ file: "/tmp/lattice-paper/./chapters/intro.tex", line: 4, level: "warning", message: "Overfull hbox." }],
      }),
    });
    const diagnosticsPanel = await screen.findByLabelText("Compile diagnostics");
    expect(visibleToasts("Build")).toEqual([]);
    // Initial and autosave builds are intentionally silent.
    expect(interfaceSounds.play).not.toHaveBeenCalled();
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    fireEvent.click(buildButton());
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("success"));
    expect(visibleToasts("Build")).toEqual([]);
    expect(diagnosticsPanel.closest(".pdf-column")).toBeInTheDocument();
    expect(diagnosticsPanel.parentElement).not.toHaveClass("workspace");
    expect(within(diagnosticsPanel).getByText("Built with 1 warning")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 warning/i }));
    fireEvent.click(screen.getByRole("button", { name: "Copy error message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("chapters/intro.tex:4 Overfull hbox."));
    fireEvent.click(screen.getByRole("tab", { name: /Log/i }));
    expect(screen.getByLabelText("Raw build log")).toHaveTextContent("Overfull hbox.");
    fireEvent.click(screen.getByRole("tab", { name: /Messages/i }));
    fireEvent.click(screen.getByRole("button", { name: /chapters\/intro\.tex:4/i }));
    await expectInvoked("read_project_file", { path: "chapters/intro.tex", projectRoot: ROOT });
    await waitFor(() => {
      const view = editorViewAt();
      expect(view.state.doc.toString()).toContain("\\section{Intro}");
      expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    });
  });

  // The editor's lint keymap also binds F8. It used to take the key whenever
  // the open file had an inline flag, so F8 stepped through that file while
  // Shift-F8 walked the build's list.
  it("walks the build's diagnostics on F8 even when the open file has an inline flag", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ files: [fileNode("main.tex"), dirNode("chapters", [fileNode("chapters/intro.tex")])] })),
      read_project_file: readFiles({
        "main.tex": "\\documentclass{article}\nSee \\ref{fig:gone}.\n",
        "chapters/intro.tex": "\\section{Intro}\none\ntwo\nthree\nfour\n",
      }, ""),
      build_project: buildResult({
        diagnostics: [{ file: "/tmp/lattice-paper/./chapters/intro.tex", line: 4, level: "warning", message: "Overfull hbox." }],
      }),
    });
    await screen.findByLabelText("Compile diagnostics");
    const view = await expectEditorText("\\documentclass{article}\nSee \\ref{fig:gone}.\n");
    await waitFor(() => {
      const flags: string[] = [];
      forEachDiagnostic(view.state, (diagnostic) => flags.push(diagnostic.message));
      expect(flags).toEqual(["Unknown label “fig:gone”."]);
    }, { timeout: 3_000 });

    fireEvent.keyDown(view.contentDOM, { key: "F8" });
    await waitFor(() => {
      const opened = editorViewAt();
      expect(opened.state.doc.toString()).toContain("\\section{Intro}");
      expect(opened.state.doc.lineAt(opened.state.selection.main.head).number).toBe(4);
    });
  });

  it("keeps the caret during repeated failed autosave builds but still navigates on manual Build", async () => {
    setAutoBuildMode("automatic");
    let diskSource = "\\documentclass{article}\n\\begin{document}\n\\label{intro\nNext line\n\\end{document}\n";
    let buildCount = 0;
    renderApp({
      ...projectCommands(), read_project_file: () => diskSource,
      write_project_file: (args) => {
        diskSource = (args as { content: string }).content;
        return { content: diskSource, hadConflicts: false };
      },
      build_project: () => {
        buildCount += 1;
        return buildResult({
          success: false, log: "Runaway argument!", durationMs: 80,
          diagnostics: [{ file: "main.tex", line: 4, level: "error", message: "Runaway argument!" }],
        })();
      },
    });
    await screen.findByLabelText("Compile diagnostics");
    const view = editorViewAt();

    for (const insert of ["中文", "修改"]) {
      const previousBuilds = buildCount;
      const from = view.state.doc.line(3).to;
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from, insert }, selection: { anchor: from + insert.length }, annotations: Transaction.userEvent.of("input.type"),
        });
      });
      const expectedText = view.state.doc.toString();
      await waitFor(() => expect(buildCount).toBe(previousBuilds + 1), { timeout: 3_000 });
      await waitForBuildIdle();
      // Navigation runs on an animation frame after the build result renders.
      await act(async () => { await pause(100); });
      expect(view.state.doc.toString()).toBe(expectedText);
      expect(view.state.selection.main.head).toBe(from + insert.length);
      expect(view.hasFocus).toBe(true);
    }

    fireEvent.click(buildButton());
    await waitFor(() => expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from));
  });
  // App resets build tracking from effects whose cleanup cancels the queued
  // pass; they must follow the project and App's lifetime, not its renders.
  describe("a build queued behind a running one", () => {
    const renderWithHeldBuild = async () => {
      setAutoBuildMode("manual");
      let held: Deferred | undefined;
      const app = renderApp({
        ...projectCommands(),
        build_project: async () => {
          const hold = held;
          held = undefined;
          if (hold) await hold.promise;
          return buildResult()();
        },
      });
      const view = await findEditorView();
      await waitForBuildIdle();
      const baseline = invokeCalls("build_project").length;
      const running = (held = deferred());
      fireEvent.click(buildButton());
      await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(baseline + 1));
      // The header's Build button queues another pass while one runs.
      fireEvent.click(buildButton());
      return { app, view, running, baseline };
    };

    it("still runs after the writer types while it waits", async () => {
      const { view, running, baseline } = await renderWithHeldBuild();
      for (const character of "Typing re-renders App.") {
        act(() => view.dispatch({
          changes: { from: view.state.doc.length, insert: character },
          annotations: Transaction.userEvent.of("input.type"),
        }));
      }
      await act(async () => {
        running.resolve();
        await pause(0);
      });
      await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(baseline + 2));
      await waitForBuildIdle();
    });

    it("is dropped when App unmounts", async () => {
      const { app, running, baseline } = await renderWithHeldBuild();
      app.unmount();
      running.resolve();
      await pause(300);
      expect(invokeCalls("build_project")).toHaveLength(baseline + 1);
    });
  });

  it("builds before a forward SyncTeX jump whenever the PDF is older than the project", async () => {
    // Regression: with manual builds, an autosaved edit left the PDF and its
    // SyncTeX map describing the old line numbers, and the jump went through
    // that map to whatever passage used to stand on the caret's line.
    setAutoBuildMode("manual");
    mockPdfDocument(() => pdfDocumentStub(1));
    let pdfUrls = 0;
    stubObjectUrls(() => `blob:lattice-sync-${++pdfUrls}`);
    const files: Record<string, string> = { "main.tex": "\\documentclass{article}" };
    let builds = 0;
    let buildFails = false;
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex", "intro.tex") })),
      read_project_file: readFiles(files),
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        files[path] = content;
      },
      build_project: () => {
        builds += 1;
        return { success: !buildFails, hasPdf: true, log: "", durationMs: 50, diagnostics: [], rootDocument: "main.tex" };
      },
      // Every compile writes new bytes, as LaTeX's timestamps do; a failed
      // pass that stopped before typesetting leaves the last PDF behind.
      read_compiled_pdf: () => new TextEncoder().encode(`%PDF-1.4 ${buildFails ? builds - 1 : builds}`).buffer,
      synctex_view: () => ({ page: 1, x: 72, y: 96, width: 120, height: 14 }),
    });
    await waitFor(() => expect(builds).toBe(1));
    const revealCursor = await screen.findByRole("button", { name: /Reveal cursor in PDF/i }, { timeout: 30_000 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    const jump = async () => {
      const lookups = invokeCalls("synctex_view").length;
      fireEvent.click(revealCursor);
      await waitFor(() => expect(invokeCalls("synctex_view").length).toBe(lookups + 1));
      await waitFor(() => expect(revealCursor).toBeEnabled());
    };
    const lastCall = (command: string) => vi.mocked(invoke).mock.calls.map(([called]) => called).lastIndexOf(command);

    // Compiled from what is on disk: the jump looks up the map as it is.
    await jump();
    expect(builds).toBe(1);

    // An edit saved without a build: the jump compiles it first.
    await appendToEditor("\n% A comment moves every line below it.");
    await waitFor(() => expect(files["main.tex"]).toContain("% A comment"), { timeout: 3_000 });
    await jump();
    expect(builds).toBe(2);
    expect(lastCall("build_project")).toBeLessThan(lastCall("synctex_view"));

    // The watcher's echo of that save and the build's own output are not
    // changes; an edit the agent made to an included file is.
    await waitFor(() => expect(tauriEventApi.handlers.get("project-fs-changed")?.size).toBeGreaterThan(0));
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: [".lattice-0b7e4c1a-9f3d-4e2b-8a6c-5d1f2e3a4b5c.tmp", "main.aux", "main.pdf", "main.synctex.gz", "main.tex"] });
    await jump();
    expect(builds).toBe(2);
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["intro.tex"] });
    await jump();
    expect(builds).toBe(3);

    // The echo absorbs one report of the saved file: an outside write to it
    // right after the save is a change too.
    await appendToEditor("\n% Another saved edit.");
    await waitFor(() => expect(files["main.tex"]).toContain("% Another saved edit."), { timeout: 3_000 });
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: [".lattice-0b7e4c1a-9f3d-4e2b-8a6c-5d1f2e3a4b5c.tmp", "main.tex"] });
    await jump();
    expect(builds).toBe(4);
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["main.tex"] });
    await jump();
    expect(builds).toBe(5);

    // A build that fails without writing a new PDF leaves the old map, which
    // no jump may use.
    buildFails = true;
    emitTauriEvent("project-fs-changed", { root: ROOT, paths: ["intro.tex"] });
    const lookups = invokeCalls("synctex_view").length;
    fireEvent.click(revealCursor);
    await expectNotification(/The PDF is not compiled from this source yet/);
    expect(builds).toBe(6);
    expect(invokeCalls("synctex_view")).toHaveLength(lookups);
  }, 60_000);

  it("jumps from the caret to the PDF while the document is in Edit mode", async () => {
    // Regression (Beta r23): the jump required the Split or PDF view, a leftover
    // from when the PDF only showed beside the source. The PDF is a panel of
    // its own now, and the view mode is shared: the guided tutorial opens in
    // Edit, choosing Edit for a Markdown file or a Paper carries over, and a
    // LaTeX file has no view switch to set it back, so "Reveal cursor in PDF"
    // stayed disabled and ⌘⇧J did nothing.
    setAutoBuildMode("manual");
    persistLayout(ROOT, { openTabs: ["main.tex"], activeFile: "main.tex", canvasMode: "source" });
    mockPdfDocument(() => pdfDocumentStub(1));
    let pdfUrls = 0;
    stubObjectUrls(() => `blob:lattice-edit-sync-${++pdfUrls}`);
    renderApp({
      ...projectCommands(projectSnapshot()),
      read_project_file: readFiles({ "main.tex": "\\documentclass{article}" }),
      build_project: buildResult({ hasPdf: true, durationMs: 50 }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      synctex_view: () => ({ page: 1, x: 72, y: 96, width: 120, height: 14 }),
    });
    await expectInvoked("read_compiled_pdf", { projectRoot: ROOT });
    await findEditorView();
    const revealCursor = await screen.findByRole("button", { name: /Reveal cursor in PDF/i }, { timeout: 30_000 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 1, column: 0 });
    expect(await screen.findByLabelText("Source location in PDF")).toBeInTheDocument();
  }, 60_000);

  it("leaves the PDF viewer alone while the writer types, until a heading changes", async () => {
    // Regression: the outline, the jump to the PDF and the diagnostics above
    // it followed every keystroke, and each re-rendered the PDF viewer.
    setAutoBuildMode("manual");
    persistLayout(ROOT, { openTabs: ["main.tex"], activeFile: "main.tex", canvasMode: "source" });
    mockPdfDocument(() => pdfDocumentStub(1));
    stubObjectUrls(() => "blob:lattice-typing");
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}\n\\begin{document}\nSome text.\n\\section{Intro}\nBody.\n\\section{Method}\n\\end{document}",
    };
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex") })),
      read_project_file: readFiles(files),
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        files[path] = content;
      },
      build_project: buildResult({
        hasPdf: true,
        diagnostics: [{ level: "warning", message: "Overfull \\hbox (4.2pt too wide) in paragraph", file: "main.tex", line: 5 }],
      }),
      read_compiled_pdf: () => new TextEncoder().encode("%PDF-1.4").buffer,
      synctex_view: () => ({ page: 1, x: 72, y: 96, width: 120, height: 14 }),
    });
    const view = await findEditorView(".source-editor .cm-editor");
    const revealCursor = await screen.findByRole("button", { name: /Reveal cursor in PDF/i }, { timeout: 30_000 });
    await waitFor(() => expect(revealCursor).toBeEnabled());
    expect(await screen.findByLabelText("Compile diagnostics")).toBeInTheDocument();
    // Above both headings, so every keystroke moves where they start.
    const caret = view.state.doc.toString().indexOf("text.");
    act(() => view.dispatch({ selection: { anchor: caret } }));
    await act(async () => {});
    const settled = pdfPreviewRenders.count;
    for (const letter of "more ") {
      act(() => view.dispatch({ changes: { from: view.state.selection.main.head, insert: letter }, selection: { anchor: view.state.selection.main.head + 1 } }));
      await act(async () => {});
    }
    expect(view.state.doc.toString()).toContain("Some more text.");
    expect(pdfPreviewRenders.count).toBe(settled);

    // The jump still starts from where the caret is now.
    fireEvent.click(revealCursor);
    await expectInvoked("synctex_view", { path: "main.tex", line: 3, column: 10 });
    await waitFor(() => expect(revealCursor).toBeEnabled());

    // A renamed heading is the outline's news: the PDF's outline lists it.
    const heading = view.state.doc.toString().indexOf("Method");
    act(() => view.dispatch({ changes: { from: heading, to: heading + "Method".length, insert: "Methods" } }));
    fireEvent.click(screen.getByRole("button", { name: "Show document outline" }));
    const outline = await screen.findByLabelText("Document outline");
    expect(within(outline).getByRole("button", { name: "Methods" })).toBeInTheDocument();
    expect(within(outline).getByRole("button", { name: "Intro" })).toBeInTheDocument();
  }, 60_000);

  it("quotes the line being typed in an expanded build error's excerpt", async () => {
    // The diagnostics above the PDF read the buffer only while they can show
    // it; expanded, an error's excerpt still follows the writer's edits.
    setAutoBuildMode("manual");
    persistLayout(ROOT, { openTabs: ["main.tex"], activeFile: "main.tex", canvasMode: "source" });
    mockPdfDocument(() => pdfDocumentStub(1));
    stubObjectUrls(() => "blob:lattice-excerpt");
    const files: Record<string, string> = { "main.tex": "\\documentclass{article}\n\\begin{document}\nSee \\cietp{vaswani}.\n\\end{document}" };
    renderApp({
      ...projectCommands(projectSnapshot({ files: fileNodes("main.tex") })),
      read_project_file: readFiles(files),
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        files[path] = content;
      },
      build_project: buildResult({
        success: false,
        log: "./main.tex:3: Undefined control sequence.\nl.3 See \\cietp\n          {vaswani}.\n",
        diagnostics: [{ level: "error", message: "Undefined control sequence.", file: "main.tex", line: 3 }],
      }),
    });
    const view = await findEditorView(".source-editor .cm-editor");
    const diagnostics = await screen.findByLabelText("Compile diagnostics", {}, { timeout: 30_000 });
    const excerpt = () => diagnostics.querySelector(".compile-excerpt-line[data-failing]");
    await waitFor(() => expect(excerpt()).toHaveTextContent("See \\cietp{vaswani}."));
    const at = view.state.doc.toString().indexOf("See ") + "See ".length;
    act(() => view.dispatch({ changes: { from: at, insert: "also " } }));
    await waitFor(() => expect(excerpt()).toHaveTextContent("See also \\cietp{vaswani}."));
  }, 60_000);

  it.each([
    ["saves dirty buffers before switching project files", false],
    ["does not make file switching wait for post-save project scans", true],
  ] as const)("%s", async (_name, holdScans) => {
    setAutoBuildMode("manual");
    const files: Record<string, string> = { "main.tex": "\\documentclass{article}", "intro.tex": "\\section{Intro}" };
    let saved = false;
    const history = deferred<never[]>();
    renderApp({
      ...refreshableProject(projectSnapshot({ files: fileNodes("main.tex", "intro.tex") })), read_project_file: readFiles(files, ""),
      write_project_file: (args) => {
        const { path, content } = args as { path: string; content: string };
        files[path] = content;
        saved = true;
      },
      list_history: () => (holdScans && saved ? history.promise : []),
    });
    await appendToEditor("\nDraft change.");
    await waitFor(() => expect(document.querySelector(".active-document i")).not.toBeNull());
    fireEvent.click(await findProjectTreeItem("intro.tex"));
    await expectInvoked("write_project_file", {
      path: "main.tex", content: "\\documentclass{article}\nDraft change.", baseContent: "\\documentclass{article}", projectRoot: ROOT,
    });
    await expectInvoked("read_project_file", { path: "intro.tex", projectRoot: ROOT });
    await expectEditorText("\\section{Intro}");
    history.resolve([]);
  });
});

// Documents with Settings.
describe("documents and editors", () => {

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
    await findSettingsDialog();
    fireEvent.click(screen.getByRole("button", { name: "Editor & builds" }));
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

// Overleaf sync with the editor and the Papers reader.
describe("Overleaf sync", () => {

  it("does not start a full sync when an opened Overleaf project is unchanged", async () => {
    let syncCount = 0;
    renderOverleafPaper({
      overleaf_link: () => overleafLink({ projectId: "ol-unchanged", lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_probe: () => overleafProbe({ remoteVersion: 42, lastSync: "2026-09-03T00:00:00Z" }),
      overleaf_sync: () => {
        syncCount += 1;
        return overleafSyncResult();
      },
      overleaf_rt_connect: () => overleafSession({ docs: [] }),
    });
    await expectInvoked("overleaf_probe", { projectRoot: "/tmp/lattice-overleaf-paper", checkLocal: true, live: [] });
    await act(async () => { await Promise.resolve(); });
    expect(syncCount).toBe(0);
    expect(screen.queryByRole("button", { name: "Syncing with Overleaf…" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
  });

  // The fourth report of a tab coming back at the top, from an Overleaf-synced
  // project: each return to a document carried live joins it again, and
  // Overleaf's copy of it (the very text on screen) arrived with a request to
  // put the view back at the top, a frame after the tab came back in place.
  it.each(["main_v2.txt", "main_v2.tex"])("brings %s back where it was left when Overleaf's copy of it arrives", async (long) => {
    const short = long.replace("main_v2", "abstract");
    const snapshot = projectSnapshot({
      root: "/tmp/lattice-tab-return", projectId: "tab-return", name: "Tab return", rootDocuments: MAIN_DOCUMENT,
      files: fileNodes("main.tex", short, long),
    });
    const files: Record<string, string> = {
      "main.tex": "\\documentclass{article}",
      [short]: "Abstract\n\nA short summary.",
      [long]: Array.from({ length: 300 }, (_, index) => `Paragraph ${index}: sparse attention at scale, line after line.`).join("\n"),
    };
    const paths: Record<string, string> = { main: "main.tex", short, long };
    const rejoin = deferred();
    let longJoins = 0;
    renderOverleafPaper({
      read_project_file: readFiles(files),
      stat_project_file: { exists: true, mtimeMs: 1 },
      write_project_file: (args) => ({ content: (args as { content: string }).content, hadConflicts: false }),
      overleaf_rt_connect: () => overleafSession({
        publicId: "me", userId: "me", docs: Object.entries(paths).map(([id, path]) => ({ id, path })),
      }),
      overleaf_rt_join_doc: async (args) => {
        const path = paths[(args as { docId: string }).docId];
        if (path === long && (longJoins += 1) === 2) await rejoin.promise;
        return { text: files[path], version: 4, comments: [], changes: [], caughtUp: [], resumed: false };
      },
      overleaf_rt_leave_doc: null,
      overleaf_rt_update_position: null,
    }, { snapshot, syncMode: "live" });
    const primaryEditor = ".source-editor[data-editor-pane='primary'] .cm-editor";
    const delivered = () => invokeCalls("write_project_file", (args) => argPath(args) === long).length;
    await openTreeFile(short);
    await openTreeFile(long);
    await waitFor(() => expect(delivered()).toBe(1), { timeout: 10_000 });

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(short.replace(".", "\\.")) }));
    await waitForSelectedTab(short);
    await expectEditorText(files[short], primaryEditor);
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(long.replace(".", "\\.")) }));
    await waitForSelectedTab(long);
    await waitFor(() => expect(longJoins).toBe(2));
    await act(() => nextFrames(3));
    // Back in its place (jsdom lays nothing out, so the place is a pretend scroll offset).
    const view = await expectEditorText(files[long], primaryEditor);
    view.scrollDOM.scrollTop = 4_800;
    fireEvent.scroll(view.scrollDOM);

    await act(async () => { rejoin.resolve(); });
    await waitFor(() => expect(delivered()).toBe(2));
    await act(() => nextFrames(3));
    expect(editorViewAt(primaryEditor)).toBe(view);
    expect(view.scrollDOM.scrollTop).toBe(4_800);
  });

  it("keeps a local Paper editable when its project is read-only on Overleaf", async () => {
    renderApp({
      ...refreshableProject(overleafPaperSnapshot()), list_papers: () => [attentionPaper({ hasBlog: false })],
      read_paper: "## Abstract\n\nPaper content.\n\n## Method\n\nEditable notes.",
      ...overleafCommands({
        overleaf_link: () => overleafLink({ projectId: "ol-read-only" }),
        overleaf_rt_connect: () => overleafSession({ permission: "readOnly" }),
        overleaf_status: () => overleafStatus({ email: "reader@example.com", name: "Reader" }),
      }),
    });
    await expectInvoked("overleaf_rt_connect", { projectRoot: "/tmp/lattice-overleaf-paper" });
    await openPaper("Attention Is All You Need");
    const paperEditor = await screen.findByRole("textbox", { name: "Markdown document editor" });
    await waitFor(() => expect(paperEditor).toHaveAttribute("contenteditable", "true"));
    // Block controls follow the pointer; hovering a block offers its grip.
    fireEvent.mouseMove(paperEditor.firstElementChild!);
    expect(await screen.findByRole("button", { name: "Select block" })).toBeInTheDocument();
  });

  it("routes toolbar and status comments to one Overleaf drawer while preserving local history", async () => {
    setAutoBuildMode("manual");
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    const snapshot = projectSnapshot({
      root: "/tmp/unified-comments", projectId: "unified-comments", name: "Review paper", rootDocuments: MAIN_DOCUMENT,
    });
    const comments = [false, true].map((resolved, index) => ({
      id: `local-${index}`, path: index ? "unsynced.tex" : "main.tex", from: 0, to: 5,
      quote: "alpha", prefix: "", suffix: " beta", body: index ? "Local history" : "Local review",
      authorId: "reviewer", authorName: "Reviewer", resolved, replies: [],
      createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
    }));
    renderApp({
      ...refreshableProject(snapshot, "alpha beta"), list_annotations: { annotations: comments, rounds: [] }, save_annotations: undefined,
      overleaf_link: () => overleafLink({ projectId: "remote-project", projectName: "Review paper" }),
      ...OVERLEAF_EMPTY_FEEDS,
      overleaf_threads: () => [{
        id: "remote-thread", resolved: false, resolvedBy: null, resolvedAt: null,
        messages: [{ id: "message", content: "Remote review", authorName: "Collaborator", authorEmail: "", timestamp: Date.now(), mine: false }],
      }],
      overleaf_probe: () => overleafProbe(), overleaf_status: () => overleafStatus(),
    });
    const toolbar = await screen.findByRole("button", { name: "Overleaf comments and chat · 2 waiting" });
    expect(document.querySelector('.canvas-toolbar button[aria-label="Annotations"]')).toBeNull();
    fireEvent.click(toolbar);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    // A slow chunk shows the drawer's loading shell, which docks in the same
    // drawer and stays its minimum time over the drawer arriving under it.
    await waitFor(() => expect(document.querySelector(".tool-loading-shell")).toBeNull());
    expect(document.querySelectorAll(".overleaf-collab-drawer")).toHaveLength(1);
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^Local/ }));
    expect(await screen.findByText("Local review")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    expect(screen.getByText("Local history")).toBeInTheDocument();
    expect(screen.getByText("unsynced.tex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Local review\. “alpha”/ }));
    await waitFor(() => expect(document.querySelector(".overleaf-collab-drawer")).toBeNull());
    fireEvent.click(document.querySelector<HTMLButtonElement>(".status-comments")!);
    expect(await screen.findByText("Remote review")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Comments2/ })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(".editor-comments-drawer")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("save_annotations", expect.anything());
    fireEvent.click(screen.getByRole("tab", { name: /^Local/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByPlaceholderText("Reply to Reviewer"), { target: { value: "Local-only reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await expectInvoked("save_annotations", expect.objectContaining({
      annotations: [
        expect.objectContaining({ id: "local-0", replies: [expect.objectContaining({ body: "Local-only reply" })] }),
        comments[1],
      ],
    }));
    expect(invoke).not.toHaveBeenCalledWith("overleaf_reply_to_thread", expect.anything());
  });

  it("silently retries a transient automatic Overleaf outage but reports it for manual sync", async () => {
    const transportFailure = new Error("error decoding response body");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const scheduledTimeouts = vi.spyOn(window, "setTimeout");
    let syncCount = 0;
    let failSync = true;
    let probeChanged = false;
    renderOverleafPaper({
      overleaf_sync: () => {
        syncCount += 1;
        if (failSync) throw transportFailure;
        return overleafSyncResult();
      },
      overleaf_probe: (args) => overleafProbe({
        changed: probeChanged, localChanged: Boolean((args as { checkLocal?: boolean } | undefined)?.checkLocal),
        remoteVersion: probeChanged ? 77 : 1,
      }),
    }, { syncMode: "live" });
    const gitAutoCommitted = () => vi.mocked(invoke).mock.calls.some(([command]) => command === "git_auto_commit");
    await waitFor(() => expect(syncCount).toBe(1), { timeout: 30_000 });
    await waitFor(() => expect(formatAppLogs()).toMatch(/error decoding response body/));
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    failSync = false;
    vi.setSystemTime(1_030_000);
    const poll = [...scheduledTimeouts.mock.calls].reverse().find(([, delay]) => delay === 3_000)?.[0];
    scheduledTimeouts.mockRestore();
    expect(poll).toBeTypeOf("function");
    act(() => { (poll as () => void)(); });
    await waitFor(() => expect(syncCount).toBe(2));
    expect(gitAutoCommitted()).toBe(false);
    expect(visibleToasts("Overleaf")).toHaveLength(0);

    const syncButton = await findOverleafSyncButton();
    probeChanged = true;
    vi.setSystemTime(1_060_000);
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(syncCount).toBe(3));
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", {
      projectRoot: "/tmp/lattice-overleaf-paper", live: [], observedRemoteVersion: 77,
      diagnosticContext: { operation_id: expect.any(String), request_id: expect.any(String) },
    });
    expect(gitAutoCommitted()).toBe(false);

    await waitFor(() => expect(syncButton).not.toBeDisabled());
    probeChanged = false;
    failSync = true;
    fireEvent.click(syncButton);

    await waitFor(() => expect(syncCount).toBe(4));
    await expectNotification(/Sync failed[\s\S]*error decoding response body/);
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull(), { timeout: 30_000 });
  });

  it.each([
    { cached: false, fallback: false }, { cached: true, fallback: false }, { cached: true, fallback: true },
  ])("opens an AlphaXiv overview and routes source links (%j)", async ({ cached, fallback }) => {
    const url = "https://www.alphaxiv.org/abs/2609.mimo-scaling-reinforcement-learning";
    const citationUrl = `${url}.pdf#page=8`;
    const paper = { arxivId: "web-0123456789abcdef", url, title: "MiMo-V2.6", hasFullText: fallback, hasBlog: cached };
    renderApp({
      ...refreshableProject(), list_papers: () => [{ ...paper }],
      fetch_web_reference: () => {
        paper.hasBlog = true;
        return { arxivId: paper.arxivId, paperPath: "", blogPath: `.research/papers/${paper.arxivId}/blog.md` };
      },
      read_paper: () => {
        if (fallback) return "# Original full text\n\nWe use a large training dataset with many tokens per sequence";
        throw new Error("Full text unavailable");
      },
      paper_pdf_preview_url: () => {
        if (fallback) throw new Error("PDF unavailable");
        return "http://127.0.0.1:3456/paper.pdf?token=test";
      },
      read_paper_blog_local: () => `# MiMo overview\n\nTraining uses 1,568 prompts. [p8](${citationUrl} "We use a large training … tokens per sequence")`,
    });
    fireEvent.click(await screen.findByRole("button", { name: /^MiMo-V2\.6/ }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const citation = await screen.findByRole("link", { name: "p8" });
    expect(citation).toHaveAttribute("href", citationUrl);
    expect(citation).toHaveAttribute("title", "We use a large training … tokens per sequence");
    expect(screen.getByRole("button", { name: "View original PDF" })).toBeVisible();
    const blogViewport = citation.closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(blogViewport, 600, 2400);
    blogViewport.scrollTop = 735;
    fireEvent.scroll(blogViewport);
    fireEvent.click(citation);
    await expectInvoked("paper_pdf_preview_url", { url: `${url}.pdf` });
    if (fallback) {
      expect(await screen.findByRole("heading", { name: "Original full text" })).toBeVisible();
      await waitFor(() => expect(window.getSelection()?.toString()).toBe("We use a large training dataset with many tokens per sequence"));
    }
    expect(await screen.findByRole("button", { name: "Back to Blog" })).toBeVisible();
    expect(openUrl).not.toHaveBeenCalledWith(citationUrl);
    fireEvent.click(screen.getByRole("button", { name: "Back to Blog" }));
    expect(await screen.findByRole("heading", { name: "MiMo overview" })).toBeVisible();
    const returnedViewport = screen.getByRole("link", { name: "p8" }).closest<HTMLElement>('[data-testid="editor-scroll-container"]')!;
    stubScrollBox(returnedViewport, 600, 2400);
    await waitFor(() => expect(returnedViewport.scrollTop).toBe(735));
    expect(invoke).not.toHaveBeenCalledWith("fetch_paper", expect.anything());
    if (!cached) expect(invoke).toHaveBeenCalledWith("fetch_web_reference", { url, requestId: expect.any(String) });
  });
});

// Project flows that land in the canvas: opening, palettes, layouts, saves on leaving the editor.
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
    // The Panels menu shows or hides each panel and keeps maximize and reset;
    // neither the whole-workspace overview nor the Trellis credit is there. The
    // credit is kept in the native macOS About panel (src-tauri/src/native_locale.rs)
    // and in NOTICE / THIRD_PARTY_NOTICES.
    fireEvent.pointerDown(within(panelControls).getByRole("button", { name: "Panels" }), { button: 0 });
    expect(await screen.findByRole("menuitemcheckbox", { name: /^Project/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitem", { name: /Maximize focused panel/ })).toBeInTheDocument();
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
  describe("open in browser", () => {
    const openProject = (commands = {}) => renderApp({
      ...projectCommands(projectSnapshot({ files: [] })), open_in_browser: null, return_to_desktop: null, ...commands,
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
    // The Writing layout is on screen (it lies over the workspace, whose tab is then not chosen).
    const writingLayout = () => document.querySelector('[data-trellis-part="panel"][data-panel="panel-writing"]');
    const resetLayout = async () => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Panels" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(await screen.findByRole("menuitem", { name: "Reset layout" }));
    };
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
      await chooseLayoutPreset("Writing");
      await waitFor(() => expect(writingLayout()).not.toBeNull());

      await resetLayout();
      await waitFor(() => expect(agentTab()).not.toBeNull());
      expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
      await waitFor(() => expect(getAppToastOptions(resetToast()!.id)?.primaryAction?.label).toBe("Undo"));
      // Placing the open documents back is the reset's own doing: the offer stands.
      await pause(300);
      await undo();
      await waitFor(() => expect(writingLayout()).not.toBeNull());
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
      await resetLayout();
      await waitFor(() => expect(resetToast()).toBeDefined());
      await chooseLayoutPreset("Reading");
      await waitFor(() => expect(resetToast()).toBeUndefined());
    });

    it("neither resets nor offers Undo when saving first fails", async () => {
      renderApp({ ...projectCommands(), write_project_file: () => { throw new Error("disk full"); } });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
      await resetLayout();
      await expectNotification(/Save failed, so the layout was not reset/);
      expect(resetToast()).toBeUndefined();
    });

    it("resets once, keeping the arrangement to undo to, when asked again while saving first", async () => {
      persistLayoutWithoutAgent();
      const written = deferred();
      renderApp({ ...projectCommands(), write_project_file: () => written.promise });
      const view = await findEditorView(".source-editor[data-editor-pane='primary'] .cm-editor");
      await chooseLayoutPreset("Writing");
      await waitFor(() => expect(writingLayout()).not.toBeNull());
      act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\n% unsaved" } }));
      await resetLayout();
      await waitFor(() => expect(invokeCalls("write_project_file")).toHaveLength(1));
      // A second press while the first reset still waits on its save.
      await resetLayout();
      await act(async () => { written.resolve(); });
      await waitFor(() => expect(getAppToastOptions(resetToast()!.id)?.primaryAction?.label).toBe("Undo"));
      expect(layoutTab("Workspace")).toHaveAttribute("aria-selected", "true");
      await pause(300);
      // Undo brings back what the writer had, not the default the first reset left.
      await undo();
      await waitFor(() => expect(writingLayout()).not.toBeNull());
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
        await resetLayout();
        await waitFor(() => expect(invokeCalls("write_project_file")).toHaveLength(1));
        await chooseProjectMenuItem("Guided tutorial");
        await expectInvoked("open_tutorial_project");
        await waitFor(() => expect(screen.getByRole("button", { name: "Switch project" })).toHaveTextContent("Next project"));
        await findEditorView();
        await chooseLayoutPreset("Writing");
        await waitFor(() => expect(writingLayout()).not.toBeNull());
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
        expect(writingLayout()).not.toBeNull();
        expect(storedLayout()).toBe(outgoing);
      });

      it("does not report the reset as failed in the next project when the save fails", async () => {
        const written = deferred();
        const outgoing = await resetThenSwitch(written.promise);
        await act(async () => { written.reject(new Error("disk full")); });
        await pause(100);
        expect(formatAppLogs()).not.toMatch(/the layout was not reset/);
        expect(resetToast()).toBeUndefined();
        expect(writingLayout()).not.toBeNull();
        expect(storedLayout()).toBe(outgoing);
      });
    });
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

// Welcome-screen flows that go on into the opened project's editor.
describe("welcome screen", () => {

  it("starts the first build as soon as a new project opens", async () => {
    const snapshot = projectSnapshot({ root: "/tmp/research/New paper", projectId: "new-paper-id", name: "New paper" });
    vi.mocked(open).mockResolvedValue("/tmp/research");
    renderApp({
      ...projectCommands(null), create_project: snapshot, build_project: buildResult(),
      // Creation no longer binds a window; the caller places the project.
      open_project: snapshot,
    });
    fireEvent.click(await screen.findByRole("button", { name: /new project/i }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New paper" } });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Venue template" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "ICML" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location" }));
    await expectInvoked("create_project", { parent: "/tmp/research", name: "New paper", venue: "icml" });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: "/tmp/research/New paper" }));
    expect(await screen.findByRole("button", { name: "Switch project" })).toHaveTextContent("New paper");
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  }, 30_000);

  it("preserves a forced build queued behind an ordinary build", async () => {
    const success = buildResult({ durationMs: 1 })();
    const ordinaryBuild = deferred<typeof success>();
    let buildCalls = 0;
    renderApp({ ...projectCommands(), build_project: () => (++buildCalls === 1 ? ordinaryBuild.promise : success) });
    await waitFor(() => expect(buildButton()).toHaveAttribute("aria-busy", "true"));
    await waitFor(() => expect(buildCalls).toBe(1));
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Clean rebuild/i }));
    // The palette runs its choice once it has closed and handed focus back.
    await waitFor(() => expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument());
    for (let tick = 0; tick < 2; tick += 1) await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(buildCalls).toBe(1);
    ordinaryBuild.resolve(success);
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(2));
    expect(invokeCalls("build_project")[1]?.[1]).toEqual(expect.objectContaining({ force: true }));
    // The queued build can finish before the lazy editor imports do. Let the
    // real canvas mount before teardown so those imports keep a live test host.
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  });

  // The Build button reports how the last build ended, whatever started it:
  // opening the project, ⌘S, or the palette.
  it("shows the last build's result on the Build button: a check and its time, or Failed", async () => {
    setAutoBuildMode("manual");
    let answer = buildResult({ durationMs: 3_200 })();
    renderApp({ ...projectCommands(), build_project: () => answer });
    const showing = () => buildButton().querySelector(".trellis-build-label > span:not(.trellis-build-label-off)")?.textContent;
    await waitFor(() => expect(buildButton()).toHaveClass("is-succeeded"));
    expect(showing()).toBe("3.2 s");
    answer = failedBuild("Undefined control sequence.")();
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(buildButton()).toHaveClass("is-failed"));
    expect(showing()).toBe("Failed");
    answer = buildResult({ durationMs: 1_500 })();
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Build project/i }));
    await waitFor(() => expect(buildButton()).toHaveClass("is-succeeded"));
    expect(showing()).toBe("1.5 s");
    expect(buildButton()).not.toHaveAttribute("aria-busy");
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
  });

  it("leaves project commands' shortcuts idle on the welcome screen, so none waits for the next project", async () => {
    localStorage.setItem("lattice.recent-commands.v1", JSON.stringify(["cite", "find"]));
    vi.mocked(open).mockResolvedValue(ROOT);
    renderApp({ ...projectCommands(null), open_project: projectSnapshot() });
    await screen.findByRole("heading", { name: "Research, written with evidence" });
    for (const key of ["f", "k", "l", "o"]) fireEvent.keyDown(window, { key, metaKey: true, shiftKey: true });
    for (const key of ["p", "g", "s"]) fireEvent.keyDown(window, { key, metaKey: true });

    fireEvent.click(screen.getByRole("button", { name: /open folder/i }));
    expect(await screen.findByLabelText("Editor status", {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
