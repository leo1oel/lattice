import { interfaceSounds, pdfSlickTestApi, tauriCoreApi, tauriEventApi, emitTauriEvent, fileNode, fileNodes, dirNode, projectCommands, refreshableProject, ROOT, projectSnapshot, rootDocument, MAIN_DOCUMENT, markdownSnapshot, buildResult, failedBuild, readFiles, deferred, setAutoBuildMode, setInterfaceLanguage, buildButton, waitForBuildIdle, selectDocumentView, findProjectTreeItem, renderApp, openWithAutomaticBuilds, expectNotification, findFrame, editorViewAt, findEditorView, appendToEditor, expectEditorText, expectInvoked, invokeCalls, pause, persistLayout, waitForSelectedTab, openTreeFile, visibleToasts, pdfDocumentStub, mockPdfDocument, stubObjectUrls } from "./app-test-utils";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { completionStatus, insertBracket, selectedCompletionIndex } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import { StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";
import { formatAppLogs } from "../telemetry/app-log-store";
import { loadTextLanguageExtensions } from "../editor/editor-languages";
import { loadVisualMarkdownEditorModule } from "../canvas/canvas-lazy-modules";

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

  it("automatically rebuilds after the active source changes on disk", async () => {
    let source = "\\documentclass{article}";
    let mtimeMs = 1;
    await openWithAutomaticBuilds({ read_project_file: () => source, stat_project_file: () => ({ exists: true, mtimeMs }) });
    source = "\\documentclass{article}\nExternal edit.";
    mtimeMs = 2;
    await waitFor(() => expect(invoke)
      .toHaveBeenCalledWith("build_project", expect.objectContaining({ force: false, projectRoot: ROOT })), { timeout: 3_500 });
    expect(interfaceSounds.play).not.toHaveBeenCalled();
  });

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
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
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
    await waitFor(() => expect(interfaceSounds.play).toHaveBeenCalledWith("build-succeeded"));
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

  it("shows failed build guidance once and acknowledges a manual retry", async () => {
    renderApp({
      ...projectCommands(),
      build_project: failedBuild(
        "Missing style file `iclr2026_conference.sty`. It is part of the ICLR template and belongs next to main.tex — "
          + "TeX Live cannot install it. Sync or copy it back from another copy of the project.",
        "LaTeX Error: File `iclr2026_conference.sty' not found.\n",
      ),
    });
    await waitFor(() => {
      expect(visibleToasts("Build")).toHaveLength(0);
      expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
    });
    const diagnostics = await screen.findByLabelText("Compile diagnostics", {}, { timeout: 40_000 });
    expect(within(diagnostics).getByText("Build failed · 1 error")).toBeInTheDocument();
    expect(within(diagnostics).getByText(/Sync or copy it back from another copy/)).toBeInTheDocument();
    fireEvent.click(within(diagnostics).getByRole("button", { name: "Dismiss diagnostics" }));
    expect(screen.queryByLabelText("Compile diagnostics")).not.toBeInTheDocument();
    const buildsBeforeManualRequest = invokeCalls("build_project").length;
    fireEvent.click(buildButton());
    await waitFor(() => expect(invokeCalls("build_project")).toHaveLength(buildsBeforeManualRequest + 1));
    await waitFor(() => expect(visibleToasts("Build")).toHaveLength(0));
    expect(await screen.findByLabelText("Compile diagnostics")).toBeInTheDocument();
    expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
  }, 40_000);

  it("installs a missing LaTeX package in-app and rebuilds", async () => {
    await setInterfaceLanguage("zh-CN");
    const install = deferred();
    renderApp({
      ...projectCommands(), start_tex_dependency_install: () => install.promise,
      build_project: failedBuild(
        "Missing LaTeX dependency `newtxmath.sty`. BasicTeX does not include every package available on Overleaf.",
        "LaTeX Error: File `newtxmath.sty' not found.\n",
      ),
    });
    const diagnostics = await screen.findByLabelText("编译诊断");
    fireEvent.click(within(diagnostics).getByRole("button", { name: "安装" }));
    await expectInvoked("start_tex_dependency_install",
      expect.objectContaining({ missingFile: "newtxmath.sty", onProgress: expect.anything() }));
    expect(screen.getByRole("dialog", { name: "安装缺失的软件包" })).toBeInTheDocument();
    act(() => {
      tauriCoreApi.channel?.onmessage?.({ stage: "installing-dependency", progress: 0.64 });
    });
    expect(screen.getByRole("progressbar", { name: "LaTeX 软件包安装进度" })).toHaveAttribute("aria-valuenow", "64");
    const buildCallsBeforeInstall = invokeCalls("build_project").length;
    await act(async () => install.resolve());
    await waitFor(() => expect(invokeCalls("build_project").length).toBeGreaterThan(buildCallsBeforeInstall));
    expect(screen.queryByRole("dialog", { name: "安装缺失的软件包" })).not.toBeInTheDocument();
    expect(formatAppLogs()).toContain("[SUCCESS] [LaTeX 配置] LaTeX 软件包已安装");
  });

  it("does not open TeX setup when latexmk reports a missing project style", async () => {
    renderApp({
      ...projectCommands(projectSnapshot({ name: "CVPR paper" }), "\\usepackage[review]{cvpr}"),
      build_project: failedBuild(
        "Missing style file `cvpr.sty`. It is part of the CVPR template and belongs next to main.tex — TeX Live cannot install it.",
        "Latexmk: Missing input file 'cvpr.sty' message in .log file:\nLaTeX Error: File `cvpr.sty' not found.\n",
      ),
    });
    await waitFor(() => expect(formatAppLogs()).toContain("Missing style file `cvpr.sty`"));
    expect(screen.queryByRole("dialog", { name: "Install LaTeX tools" })).not.toBeInTheDocument();
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
