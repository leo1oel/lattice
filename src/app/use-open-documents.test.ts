import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PAPER, PAPER_TAB, ROOT, deferred, renderDocuments, snapshotOf } from "./open-documents-test-harness";
import { invoke } from "@tauri-apps/api/core";
import { loadWorkspaceLayout, type WorkspaceLayout } from "../settings/app-settings";
import { paperDocumentPath } from "./use-open-documents";
import { invokeCalls } from "../platform/tauri-test-mocks";

describe("opening documents", () => {
  it("overlaps the outgoing save with the incoming read, and keeps the old file when that save fails", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    docs.type("Main, edited");
    const write = docs.hold("write_project_file", "main.tex");
    const opened = act(() => docs.current().openFile("intro.tex"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", expect.objectContaining({ path: "intro.tex" })));
    expect(docs.current().file).toBe("main.tex");
    write.reject(new Error("disk full"));
    await opened;
    expect(docs.current()).toMatchObject({ file: "main.tex", text: "Main, edited", dirty: true, tabs: ["main.tex"] });
  });

  it("lets the latest open win: a slow Paper read never replaces a file opened after it", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" }, { papers: [PAPER] });
    await docs.enter();
    const paperRead = docs.hold("read_paper", "");
    let paper!: Promise<boolean>;
    act(() => { paper = docs.current().openPaper(PAPER); });
    expect(docs.current().store.getState().opening?.label).toBe("Attention");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: PAPER.arxivId }));
    await act(() => docs.current().openFile("intro.tex"));
    paperRead.resolve("Full text");
    expect(await act(() => paper)).toBe(false);
    expect(docs.current()).toMatchObject({ file: "intro.tex", paper: null, activeTab: "intro.tex" });
    expect(docs.current().store.getState().opening).toBeNull();
    expect(docs.current().tabs).toEqual(["main.tex", "intro.tex"]);
  });

  it("puts a Paper in front of the file, which keeps its buffer, and records both in the tab strip", async () => {
    const docs = renderDocuments({ "main.tex": "Main" }, { papers: [PAPER] });
    await docs.enter();
    await act(() => docs.current().openPaper(PAPER, { view: "fulltext" }));
    expect(docs.current()).toMatchObject({
      file: "main.tex", text: "Main", paper: PAPER, paperView: "fulltext", mode: "pdf", activeTab: PAPER_TAB,
    });
    expect(docs.current().canvas).toMatchObject({ path: paperDocumentPath(PAPER.arxivId, "fulltext"), text: "Full text" });
    docs.type("Full text, annotated");
    await act(async () => { await docs.current().save(); });
    expect(docs.files.get(paperDocumentPath(PAPER.arxivId, "fulltext"))).toBe("Full text, annotated");
    expect(docs.files.get("main.tex")).toBe("Main");
  });

  it("closes the open figure back to the last file tab, and reopens it through the asset reader", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" }, { paths: ["main.tex", "intro.tex", "fig.png"] });
    await docs.enter();
    await act(() => docs.current().openFile("intro.tex"));
    await act(() => docs.current().openAsset("fig.png"));
    expect(docs.current()).toMatchObject({ activeTab: "fig.png", mode: "asset" });
    await act(() => docs.current().close("fig.png"));
    expect(docs.current()).toMatchObject({ activeTab: "intro.tex", asset: null, tabs: ["main.tex", "intro.tex"] });
    await act(async () => { docs.current().reopenClosed(); });
    await waitFor(() => expect(docs.current()).toMatchObject({ activeTab: "fig.png", mode: "asset" }));
    expect(invoke).toHaveBeenLastCalledWith("read_project_asset", { path: "fig.png" });
  });

  it("goes back and forward through the lines the writer jumped between", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    await act(() => docs.current().openFile("intro.tex", { line: 12 }));
    await act(() => docs.current().go(-1));
    expect(docs.current().file).toBe("main.tex");
    await act(() => docs.current().go(1));
    expect(docs.current().file).toBe("intro.tex");
    expect(docs.view.result.current.canvas.requests.navigation).toMatchObject({ path: "intro.tex", line: 12 });
  });

  it("brings a file's remembered place back on open, unless the caller moves the view itself", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    act(() => docs.current().viewStates.remember("intro.tex", { text: { cursor: 3, scrollTop: 90 } }));
    await act(() => docs.current().openFile("intro.tex"));
    expect(docs.view.result.current.canvas.requests.restore).toMatchObject({ path: "intro.tex", cursor: 3, scrollTop: 90 });
    act(() => docs.view.result.current.canvas.update("restore", null));
    await act(() => docs.current().openFile("main.tex"));
    act(() => docs.view.result.current.canvas.update("restore", null));
    await act(() => docs.current().openFile("intro.tex", { restoreView: false }));
    expect(docs.view.result.current.canvas.requests.restore).toBeNull();
  });
});

describe("entering a project", () => {
  const layout = (overrides: Partial<WorkspaceLayout>): WorkspaceLayout => ({
    openTabs: ["main.tex", "intro.tex"], activeFile: "intro.tex", activeTab: "intro.tex", canvasMode: "source",
    documentMode: "source", bibMode: "source", paperView: "blog", ...overrides,
  });

  it("restores the saved tabs, file and mode, and persists the layout from then on", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" }, { layout: layout({}) });
    expect(await docs.enter()).toBe(true);
    expect(docs.current()).toMatchObject({ file: "intro.tex", text: "Intro", tabs: ["main.tex", "intro.tex"], mode: "source", tabsReady: true });
    await act(() => docs.current().openFile("main.tex"));
    expect(loadWorkspaceLayout(ROOT)).toMatchObject({ activeFile: "main.tex", openTabs: ["main.tex", "intro.tex"] });
  });

  it("opens a restored Paper tab through the Paper reader once the project's scans finish", async () => {
    const docs = renderDocuments({ "main.tex": "Main" }, {
      papers: [PAPER],
      layout: layout({ openTabs: ["main.tex", PAPER_TAB], activeFile: "main.tex", activeTab: PAPER_TAB, paperView: "fulltext" }),
    });
    await docs.enter();
    await waitFor(() => expect(docs.current()).toMatchObject({ paper: PAPER, paperView: "fulltext", file: "main.tex" }));
    await waitFor(() => expect(loadWorkspaceLayout(ROOT)?.activeTab).toBe(PAPER_TAB));
  });

  it("opens a restored Paper the plan found even when the rendered papers have not caught up", async () => {
    const docs = renderDocuments({ "main.tex": "Main" }, {
      layout: layout({ openTabs: ["main.tex", PAPER_TAB], activeFile: "main.tex", activeTab: PAPER_TAB, paperView: "fulltext" }),
    });
    await docs.enter({ restorePapers: [PAPER] });
    await waitFor(() => expect(docs.current()).toMatchObject({ paper: PAPER, paperView: "fulltext", file: "main.tex" }));
    await waitFor(() => expect(loadWorkspaceLayout(ROOT)?.activeTab).toBe(PAPER_TAB));
  });

  it("keeps a file the writer opened during the scans over the restored Paper", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "notes.tex": "Notes" }, {
      papers: [PAPER],
      layout: layout({ openTabs: ["main.tex", PAPER_TAB], activeFile: "main.tex", activeTab: PAPER_TAB }),
    });
    await docs.enter({ beforeFinish: () => docs.current().openFile("notes.tex") });
    expect(docs.current()).toMatchObject({ file: "notes.tex", paper: null, tabsReady: true });
    expect(invoke).not.toHaveBeenCalledWith("read_paper", expect.anything());
  });

  it("clears the previous project's documents before the next one restores", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    await act(() => docs.current().openFile("intro.tex"));
    docs.type("Unsaved");
    act(() => {
      docs.view.result.current.projectState.beginTransition();
      docs.current().enter(snapshotOf(["main.tex"], "/other"));
    });
    expect(docs.current()).toMatchObject({ file: "", text: "", savedText: "", tabs: [], paper: null, asset: null });
  });
});

describe("tree changes", () => {
  it("carries the open file, its tab and its history along a rename", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    await act(() => docs.current().openFile("intro.tex", { line: 3 }));
    docs.files.set("chapters/intro.tex", docs.files.get("intro.tex")!);
    docs.files.delete("intro.tex");
    act(() => docs.current().move([{ previousPath: "intro.tex", nextPath: "chapters/intro.tex" }]));
    expect(docs.current()).toMatchObject({ file: "chapters/intro.tex", activeTab: "chapters/intro.tex", tabs: ["main.tex", "chapters/intro.tex"] });
    expect(docs.current().live.file.current).toBe("chapters/intro.tex");
    await act(() => docs.current().go(-1));
    await act(() => docs.current().go(1));
    expect(docs.current().file).toBe("chapters/intro.tex");
  });

  it("retires deleted tabs and puts the root document in front of a deleted file", async () => {
    const docs = renderDocuments({ "main.tex": "Main", "intro.tex": "Intro" });
    await docs.enter();
    await act(() => docs.current().openFile("intro.tex"));
    docs.files.delete("intro.tex");
    docs.setSnapshot(["main.tex"]);
    await act(() => docs.current().remove(["intro.tex"]));
    expect(docs.current()).toMatchObject({ file: "main.tex", text: "Main", tabs: ["main.tex"] });
    await act(async () => { docs.current().reopenClosed(); });
    expect(docs.current().file).toBe("main.tex");
  });
});

describe("durable text and disk", () => {
  it("shows text that reached disk only where the caller's expectation still holds", async () => {
    const docs = renderDocuments({ "main.tex": "Main" });
    await docs.enter();
    expect(docs.current().accept("other.tex", "Elsewhere")).toBe(false);
    docs.type("Main, typing");
    expect(docs.current().accept("main.tex", "From disk", "clean")).toBe(false);
    expect(docs.current().accept("main.tex", "Remote", { text: "Main", saved: "Main" })).toBe(false);
    expect(docs.current().text).toBe("Main, typing");
    let accepted = false;
    act(() => { accepted = docs.current().accept("main.tex", "Remote", { text: "Main, typing", saved: "Main" }); });
    expect(accepted).toBe(true);
    expect(docs.current()).toMatchObject({ text: "Remote", savedText: "Remote", dirty: false });
  });

  it("reloads an external edit into a clean buffer and reports it, but never over unsaved typing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const docs = renderDocuments({ "main.tex": "Main" }, { autoBuild: true });
    await docs.enter();
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    docs.touch("main.tex", "Agent wrote this");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(docs.current()).toMatchObject({ text: "Agent wrote this", dirty: false });
    expect(docs.deps.onDiskEdit).toHaveBeenCalledWith("main.tex");
    expect(docs.deps.autoBuild.afterDiskEdit).toHaveBeenCalledOnce();

    docs.type("Mine");
    docs.touch("main.tex", "Agent again");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(docs.current().text).toBe("Mine");
  });

  it("tells the source editor which text came from outside the writer's editing, to keep it out of their undo", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const docs = renderDocuments({ "main.tex": "a\nb\nc" });
    await docs.enter();
    const fromOutside = () => docs.current().canvas.isOutsideText(docs.current().canvas.text);
    expect(fromOutside()).toBe(true);
    docs.type("a\nb\nC");
    expect(fromOutside()).toBe(false);

    // A save that merged in a collaborator's line hands back text the writer never typed.
    docs.files.set("main.tex", "A\nb\nc");
    await act(async () => { await docs.current().save(); });
    expect(docs.current().canvas.text).toBe("A\nb\nC");
    expect(fromOutside()).toBe(true);

    // An agent's edit on disk, reloaded into the clean buffer.
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    docs.touch("main.tex", "A\nAgent\nC");
    await act(() => vi.advanceTimersByTimeAsync(2_600));
    expect(docs.current().canvas.text).toBe("A\nAgent\nC");
    expect(fromOutside()).toBe(true);

    // An Overleaf collaborator's live text.
    act(() => { docs.current().accept("main.tex", "Remote", { text: "A\nAgent\nC", saved: "A\nAgent\nC" }); });
    expect(fromOutside()).toBe(true);
    // The writer's own edits, figures and Markdown publications included, are theirs to undo.
    docs.type("Remote, mine");
    expect(fromOutside()).toBe(false);
  });

  it("keeps an outside edit a save merged in while typing went on behind it", async () => {
    // During an Overleaf sync a save waits until the sync is done; the sync
    // pulls a collaborator's line 1 meanwhile, and the writer keeps typing.
    const docs = renderDocuments({ "main.tex": "a\nb\nc" });
    await docs.enter();
    docs.type("a\nb\nC");
    const write = docs.hold("write_project_file", "main.tex");
    let first!: Promise<boolean>;
    act(() => { first = docs.current().save(); });
    docs.files.set("main.tex", "A\nb\nc");
    docs.type("a\nB\nC");
    await act(async () => { write.resolve(undefined); await first; });
    expect(docs.files.get("main.tex")).toBe("A\nb\nC");
    // The buffer has not seen line 1 yet, so the next save merges again
    // rather than writing the buffer over the collaborator's line.
    expect(docs.current().text).toBe("a\nB\nC");
    await act(async () => { await docs.current().save(); });
    expect(docs.files.get("main.tex")).toBe("A\nB\nC");
  });

  it("never merges a save against the writer's own save still under way: type, undo and retype saves cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const original = "\\begin{abstract}\nBriefly summarize.\n\\end{abstract}";
    const junk = "\\begin{abstract}\nBriefly summarize. hhhhhh\n\\end{abstract}";
    const retyped = "\\begin{abstract}\nBriefly summarize. what is this\n\\end{abstract}";
    const docs = renderDocuments({ "main.tex": original });
    await docs.enter();
    docs.type(junk);
    // The autosave of the junk reaches disk, but its answer is slow to come back.
    const answer = docs.hold("write_project_file", "main.tex", "answer");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(docs.files.get("main.tex")).toBe(junk);
    // ⌘Z, retype, pause: the next autosave comes due while the first is unanswered.
    docs.type(original);
    docs.type(retyped);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    answer.resolve(undefined);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(docs.files.get("main.tex")).toBe(retyped);
    expect(docs.current()).toMatchObject({ text: retyped, dirty: false });
    // The second write grew from what the first one wrote, so there was nothing to merge.
    const bases = invokeCalls("write_project_file").map(({ baseContent }) => baseContent);
    expect(bases).toEqual([original, junk]);
  });

  it("still merges a real outside edit into the save queued behind another", async () => {
    const docs = renderDocuments({ "main.tex": "a\nb\nc" });
    await docs.enter();
    docs.type("a\nB\nc");
    const write = docs.hold("write_project_file", "main.tex");
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = docs.current().save(); });
    docs.type("a\nB\nmine");
    act(() => { second = docs.current().save(); });
    // An agent rewrites the same line before either write lands.
    docs.files.set("main.tex", "a\nb\nagent");
    await act(async () => { write.resolve(undefined); await first; await second; });
    expect(docs.files.get("main.tex")).toBe("a\nB\n<<<<<<< ours\nmine\n||||||| original\nc\n=======\nagent\n>>>>>>> theirs");
  });

  it("saves after a pause in typing, and builds after the save when builds are automatic", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const docs = renderDocuments({ "main.tex": "Main" }, { autoBuild: true });
    await docs.enter();
    docs.type("Main, edited");
    await act(() => vi.advanceTimersByTimeAsync(1_100));
    expect(docs.files.get("main.tex")).toBe("Main");
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(docs.files.get("main.tex")).toBe("Main, edited");
    expect(docs.deps.onSaved).toHaveBeenCalledWith(ROOT, ["main.tex"]);
    expect(docs.deps.autoBuild.afterSave).toHaveBeenCalledOnce();
    expect(docs.current().dirty).toBe(false);
  });

  it("reports each write for the save slot: saving only once one is slow, and a failure until the next write lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const docs = renderDocuments({ "main.tex": "Main" });
    await docs.enter();
    expect(docs.current().saveStatus).toEqual({ phase: "saved", at: null, path: null });
    // A quick write goes from saved to saved: no "Saving…" flicker.
    docs.type("Main, quick");
    await act(async () => { await docs.current().save(); });
    expect(docs.current().saveStatus).toMatchObject({ phase: "saved", path: "main.tex", at: Date.now() });
    // A slow one says so after 400 ms, and settles when it lands.
    docs.type("Main, slow");
    const slow = docs.hold("write_project_file", "main.tex");
    let saving!: Promise<boolean>;
    act(() => { saving = docs.current().save(); });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(docs.current().saveStatus.phase).toBe("saved");
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(docs.current().saveStatus.phase).toBe("saving");
    await act(async () => { slow.resolve(undefined); await saving; });
    expect(docs.current().saveStatus.phase).toBe("saved");
    // A failed write keeps its reason until a later one succeeds.
    docs.type("Main, failed");
    const failing = docs.hold("write_project_file", "main.tex");
    act(() => { saving = docs.current().save(); });
    await act(async () => { failing.reject(new Error("No space left on device")); await saving; });
    expect(docs.current().saveStatus).toMatchObject({ phase: "failed", path: "main.tex", error: "No space left on device" });
    expect(docs.current().dirty).toBe(true);
    await act(async () => { await docs.current().save(); });
    expect(docs.current().saveStatus.phase).toBe("saved");
  });

  it("names the Paper reading file a failed save was for, and gives its on-screen text for a copy", async () => {
    const docs = renderDocuments({ "main.tex": "\\documentclass{book}" }, { papers: [PAPER] });
    await docs.enter();
    for (const view of ["blog", "fulltext"] as const) {
      await act(() => docs.current().openPaper(PAPER, { view }));
      const path = paperDocumentPath(PAPER.arxivId, view);
      docs.type(`${view}: READER-RECOVERY-SENTINEL`);
      const failing = docs.hold("write_project_file", path);
      let saving!: Promise<boolean>;
      act(() => { saving = docs.current().save(); });
      await act(async () => { failing.reject(new Error("Permission denied")); await saving; });
      // The slot names the reading file, not the source retained underneath.
      expect(docs.current().saveStatus).toMatchObject({ phase: "failed", path, error: "Permission denied" });
      // A visual edit the canvas has not published yet goes into the copy too.
      act(() => docs.current().canvas.registerFlush(() => {
        docs.current().canvas.setText(`${view}: READER-RECOVERY-SENTINEL, deferred`);
        return true;
      }));
      let copied: string | null = null;
      act(() => { copied = docs.current().bufferText(path); });
      expect(copied).toBe(`${view}: READER-RECOVERY-SENTINEL, deferred`);
      act(() => docs.current().canvas.registerFlush(null));
      expect(docs.current().bufferText("main.tex")).toBe("\\documentclass{book}");
      expect(docs.current().bufferText("elsewhere.tex")).toBeNull();
      await act(async () => { await docs.current().save(); });
      expect(docs.current().saveStatus).toMatchObject({ phase: "saved", path });
    }
  });

  it("holds an automatic save while the completion menu is open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const docs = renderDocuments({ "main.tex": "Main" }, { autoBuild: true });
    await docs.enter();
    act(() => docs.current().canvas.onCompletionActiveChange(true));
    docs.type("\\cite{");
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(docs.files.get("main.tex")).toBe("Main");
    act(() => docs.current().canvas.onCompletionActiveChange(false));
    await act(() => vi.advanceTimersByTimeAsync(1_300));
    expect(docs.files.get("main.tex")).toBe("\\cite{");
  });

  // The PDF panel sits beside the editor without blurring it: turning to it
  // ends the completion the canvas registered, so leaving still saves.
  it("ends the completion before leaving for the PDF, where a plain leave keeps it and waits", async () => {
    const docs = renderDocuments({ "main.tex": "Main" });
    await docs.enter();
    const close = vi.fn(() => docs.current().canvas.onCompletionActiveChange(false));
    act(() => docs.current().canvas.registerCompletionClose(close));
    act(() => docs.current().canvas.onCompletionActiveChange(true));
    docs.type("\\cite{");

    await act(async () => { docs.current().canvas.onLeave(); });
    expect(close).not.toHaveBeenCalled();
    expect(docs.files.get("main.tex")).toBe("Main");

    await act(async () => { docs.current().canvas.onLeaveForPdf(); });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() => expect(docs.files.get("main.tex")).toBe("\\cite{"));

    act(() => docs.current().canvas.registerCompletionClose(null));
    act(() => docs.current().canvas.onCompletionActiveChange(true));
    docs.type("\\cite{a");
    // With no editor registered there is no menu to end: the guard holds.
    await act(async () => { docs.current().canvas.onLeaveForPdf(); });
    expect(docs.files.get("main.tex")).toBe("\\cite{");
  });
});
