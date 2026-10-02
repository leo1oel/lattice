import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode, PaperSummary, ProjectSnapshot } from "../app-types";
import { paperTabKey } from "../app-utils";
import { loadWorkspaceLayout, persistWorkspaceLayout, type WorkspaceLayout } from "../settings/app-settings";
import { useCanvasRequests } from "./use-canvas-requests";
import { paperDocumentPath, useOpenDocuments, type OpenDocumentsDeps } from "./use-open-documents";
import { useProjectState } from "./use-project-state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.useRealTimers();
  localStorage.clear();
});

const ROOT = "/project";
const file = (path: string, kind = path.endsWith(".png") || path.endsWith(".pdf") ? "figure" : "tex"): FileNode => ({
  name: path.split("/").at(-1) ?? path, path, kind, children: [],
});
const PAPER: PaperSummary = { arxivId: "1706.03762", title: "Attention", authors: "Vaswani", hasFullText: true, hasBlog: true };
const PAPER_TAB = paperTabKey(PAPER.arxivId);

function snapshotOf(paths: string[], root = ROOT): ProjectSnapshot {
  return {
    root,
    manifest: {
      schemaVersion: 1, projectId: "paper", name: "Paper", trusted: false, primaryBibliography: "references.bib",
      rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }],
    },
    files: paths.map((path) => file(path)),
  } as ProjectSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Each line from whichever side changed it; the tests keep both sides' edits on separate lines. */
function mergeLines(base: string, ours: string, theirs: string) {
  const [baseLines, ourLines, theirLines] = [base, ours, theirs].map((text) => text.split("\n"));
  return theirLines.map((line, index) => (ourLines[index] !== baseLines[index] ? ourLines[index] : line)).join("\n");
}

/**
 * The open documents of one project over an in-memory disk. `hold(command, path)` parks the next such call
 * until the test settles the returned deferred; everything else answers at once.
 */
function renderDocuments(disk: Record<string, string>, {
  paths = Object.keys(disk), papers = [] as PaperSummary[], layout = null as WorkspaceLayout | null,
  autoBuild = false,
} = {}) {
  const files = new Map(Object.entries(disk));
  const mtimes = new Map<string, number>();
  const held = new Map<string, ReturnType<typeof deferred<unknown>>>();
  let snapshot = snapshotOf(paths);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const { path, content, baseContent } = (args ?? {}) as { path?: string; content?: string; baseContent?: string };
    const parked = held.get(`${command}:${path ?? ""}`);
    if (parked) {
      held.delete(`${command}:${path ?? ""}`);
      const value = await parked.promise;
      if (value !== undefined) return value;
    }
    switch (command) {
      case "read_project_file":
        if (!files.has(path!)) throw new Error(`No such file: ${path}`);
        return files.get(path!);
      case "write_project_file": {
        // Like the backend, merge with a disk that moved on since `baseContent`
        // (line by line here: the tests only edit separate lines).
        const disk = files.get(path!);
        const written = baseContent === undefined || disk === undefined || disk === baseContent
          ? content!
          : mergeLines(baseContent, content!, disk);
        files.set(path!, written);
        mtimes.set(path!, (mtimes.get(path!) ?? 1) + 1);
        return { content: written, hadConflicts: false };
      }
      case "stat_project_file":
        return { exists: files.has(path!), mtimeMs: mtimes.get(path!) ?? 1 };
      case "read_project_asset":
        return { path, mimeType: "image/png", base64: "AA==" };
      case "read_paper":
        return files.get(paperDocumentPath((args as { arxivId: string }).arxivId, "fulltext")) ?? "Full text";
      case "read_paper_blog_local":
        return files.get(paperDocumentPath((args as { arxivId: string }).arxivId, "blog")) ?? "Overview";
      case "refresh_project":
        return snapshot;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  if (layout) persistWorkspaceLayout(ROOT, layout);
  const deps = {
    onSaved: vi.fn(), onDiskEdit: vi.fn(),
    autoBuild: { enabled: autoBuild, afterSave: vi.fn(), afterDiskEdit: vi.fn() },
  };
  const view = renderHook(() => {
    const projectState = useProjectState();
    const canvas = useCanvasRequests();
    const documents = useOpenDocuments({
      projectState, papers, updateCanvasRequest: canvas.update, cancelPrewarm: () => {},
      refreshProject: async () => snapshot, ...deps,
    } satisfies OpenDocumentsDeps);
    return { projectState, canvas, documents };
  });
  const current = () => view.result.current.documents;
  /** Enter the project the way App does: restore its layout, run the (here instant) scans, finish. */
  const enter = async ({ beforeFinish, restorePapers = papers }: {
    beforeFinish?: () => Promise<void>; restorePapers?: PaperSummary[];
  } = {}) => {
    const { projectState, documents } = view.result.current;
    let restored = false;
    await act(async () => {
      projectState.beginTransition();
      documents.claim();
      const entry = documents.enter(snapshot);
      projectState.projectRef.current = snapshot;
      projectState.setProject(snapshot);
      restored = await entry.restore(restorePapers);
      if (!restored) return;
      await beforeFinish?.();
      entry.finish();
    });
    return restored;
  };
  /** Type into the document in front, as the canvas does. */
  const type = (text: string) => act(() => { current().canvas.setText(text); });
  return {
    view, deps, current, enter, type, files,
    hold: (command: string, path: string) => {
      const parked = deferred<unknown>();
      held.set(`${command}:${path}`, parked);
      return parked;
    },
    setSnapshot: (paths: string[]) => { snapshot = snapshotOf(paths); },
    touch: (path: string, content: string) => {
      files.set(path, content);
      mtimes.set(path, (mtimes.get(path) ?? 1) + 10);
    },
  };
}

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
    expect(docs.current().opening).toBe("Attention");
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_paper", { arxivId: PAPER.arxivId }));
    await act(() => docs.current().openFile("intro.tex"));
    paperRead.resolve("Full text");
    expect(await act(() => paper)).toBe(false);
    expect(docs.current()).toMatchObject({ file: "intro.tex", paper: null, activeTab: "intro.tex", opening: null });
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
});

describe("entering a project", () => {
  const layout = (overrides: Partial<WorkspaceLayout>): WorkspaceLayout => ({
    openTabs: ["main.tex", "intro.tex"], activeFile: "intro.tex", activeTab: "intro.tex", canvasMode: "source",
    documentMode: "source", paperView: "blog", ...overrides,
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
});
