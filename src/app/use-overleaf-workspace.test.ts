import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafThread } from "../app-types";
import { useOverleafRealtime } from "../overleaf/use-overleaf-realtime";
import { applyOverleafRemoteText, projectOverleafEditorComments, useOverleafWorkspace, type OverleafWorkspaceDeps } from "./use-overleaf-workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.useRealTimers();
  localStorage.clear();
});

function remoteFixture() {
  const deps: Parameters<typeof applyOverleafRemoteText>[0] = {
    projectRef: { current: { root: "/project" } as NonNullable<Parameters<typeof applyOverleafRemoteText>[0]["projectRef"]["current"]> },
    projectOperationGenerationRef: { current: 1 },
    activeFileRef: { current: "section.tex" },
    sourceRef: { current: "old caption" },
    savedSourceRef: { current: "old caption" },
    setSource: vi.fn(), setSavedSource: vi.fn(), setViewRestore: vi.fn(), compile: vi.fn(async () => {}),
  };
  const context = { projectRoot: "/project", path: "section.tex", baseContent: "old caption", isCurrent: () => true };
  return { deps, context };
}

describe("safe Overleaf remote text delivery", () => {
  it("keeps an agent draft when opening the file against an older live snapshot", async () => {
    const { deps } = remoteFixture();
    deps.sourceRef.current = deps.savedSourceRef.current = "agent caption and new section";
    const notice = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_rt_connect") return {
        publicId: "me", docs: [{ id: "section", path: "section.tex" }], entities: [],
        permission: "readAndWrite", trackChanges: false, userId: "me",
      };
      if (command === "overleaf_rt_join_doc") return {
        text: "old caption", version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
      };
      return undefined;
    });
    const view = renderHook(() => useOverleafRealtime({
      enabled: true, documents: true, projectRoot: "/project", activeFile: "section.tex",
      readCaret: () => 0, onNotice: notice,
      onRemoteText: (text, caret, context) => applyOverleafRemoteText(deps, text, caret, context),
    }));
    await waitFor(() => expect(notice).toHaveBeenCalled());
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", {
      projectRoot: "/project", docId: "section", receipt: expect.any(String), checkpoint: null,
    });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "write_project_file")).toBe(false);
    expect(deps.sourceRef.current).toBe("agent caption and new section");
    view.unmount();
  });

  it("does not replace the editor when disk rejects a stale live write", async () => {
    const { deps, context } = remoteFixture();
    vi.mocked(invoke).mockRejectedValue(new Error("Agent changed the disk"));
    await expect(applyOverleafRemoteText(deps, "remote caption", 3, context)).rejects.toThrow("Agent changed");
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "section.tex", projectRoot: "/project", content: "remote caption", expectedContent: "old caption",
    });
    expect(deps.sourceRef.current).toBe("old caption");
    expect(deps.setSource).not.toHaveBeenCalled();
    expect(deps.compile).not.toHaveBeenCalled();
  });

  it("updates both editor baselines and rebuilds only after a successful guarded write", async () => {
    const { deps, context } = remoteFixture();
    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(await applyOverleafRemoteText(deps, "remote caption", 3, context)).toBe(true);
    expect(deps.sourceRef.current).toBe("remote caption");
    expect(deps.savedSourceRef.current).toBe("remote caption");
    expect(deps.setSource).toHaveBeenCalledWith("remote caption");
    expect(deps.compile).toHaveBeenCalledOnce();
  });

  it.each(["typing", "navigation", "project generation"])("does not apply a late response after %s", async (change) => {
    const { deps, context } = remoteFixture();
    let resolve!: () => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const pending = applyOverleafRemoteText(deps, "remote caption", 3, context);
    if (change === "typing") deps.sourceRef.current = "my unfinished edit";
    if (change === "navigation") deps.activeFileRef.current = "other.tex";
    if (change === "project generation") deps.projectOperationGenerationRef.current += 1;
    await act(async () => { resolve(); });
    expect(await pending).toBe(false);
    expect(deps.setSource).not.toHaveBeenCalled();
    expect(deps.savedSourceRef.current).toBe("old caption");
    expect(deps.compile).not.toHaveBeenCalled();
  });
});

function syncFixture() {
  const { deps: remote } = remoteFixture();
  let disk = "old caption";
  let server = disk;
  let finishSync: (() => void) | undefined;
  let holdSync = false;
  let conflict = false;
  let failSync = false;
  let deleted = false;
  const project = {
    root: "/project", files: [], manifest: {
      schemaVersion: 1, projectId: "paper", name: "Paper", rootDocuments: [],
      primaryBibliography: "references.bib", trusted: false,
    },
  };
  const deps: OverleafWorkspaceDeps = {
    ...remote, project, activeFile: "section.tex", source: "old caption",
    setSource: vi.fn((value) => { deps.source = value; }),
    activePaper: null, activeAsset: null, viewStateRef: { current: new Map() },
    editorPosition: null, editorPositionRef: { current: null }, build: null,
    saveGeneration: 0, savedPathsRef: { current: new Set() },
    wholeFileEditingPaths: [], wholeFileDraftPaths: [], collabSession: null, collabName: "Writer",
    runSharedOverleafSync: vi.fn(), save: vi.fn(async () => true),
    loadFile: vi.fn(async (_path, options) => {
      if (options?.canCommit?.() === false) return false;
      remote.sourceRef.current = remote.savedSourceRef.current = disk;
      deps.setSource(disk);
      return true;
    }),
    refreshProject: vi.fn(async () => project), openProjectFile: vi.fn(),
    overleafSyncingRef: { current: false }, overleafSyncSettledRef: { current: null },
    resolveOverleafSyncRef: { current: null },
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "overleaf_link") return {
      projectId: "ol-paper", projectName: "Paper", host: "https://www.overleaf.com", paused: false,
    };
    if (command === "overleaf_status") return { connected: true, host: "https://www.overleaf.com" };
    if (command === "overleaf_probe") return { versionKnown: true, changed: false, localChanged: false, remoteVersion: 1 };
    if (command === "read_project_file") return disk;
    if (command === "overleaf_rt_connect") return {
      publicId: "me", docs: [{ id: "section", path: "section.tex" }], entities: [],
      permission: "readAndWrite", trackChanges: false, userId: "me",
    };
    if (command === "overleaf_rt_join_doc") return {
      text: server, version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
    };
    if (command === "overleaf_sync") {
      if (failSync) {
        failSync = false;
        throw new Error("error decoding response body");
      }
      const uploaded = disk;
      if (holdSync) await new Promise<void>((resolve) => { finishSync = resolve; });
      server = uploaded;
      return {
        pushed: conflict || deleted ? [] : ["section.tex"], pulled: [], merged: [],
        conflicts: conflict ? [{ path: "section.tex", localCopy: "section.local.tex", markers: true }] : [],
        deletedLocal: [], skippedRemoteDeletes: deleted ? ["section.tex"] : [], readOnly: false,
      };
    }
    return [];
  });
  return {
    deps, edit: (text: string) => { disk = text; },
    hold: () => { holdSync = true; },
    conflict: (alreadyResolved = false) => {
      conflict = true;
      if (!alreadyResolved) disk = "<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n";
    },
    failOnce: () => { failSync = true; },
    deleteFile: () => { deleted = true; },
    finish: () => { holdSync = false; finishSync?.(); },
    server: () => server,
  };
}

describe("external edit Overleaf handoff", () => {
  it.each([true, false])("checks current file markers before opening a conflict (already resolved: %s)", async (resolved) => {
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "manual");
    const fixture = syncFixture();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.status).toBe("live"));
    fixture.conflict(resolved);
    await act(async () => { await view.result.current.runOverleafSync(); });
    expect(view.result.current.conflictPath).toBe(resolved ? null : "section.tex");
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "section.tex", projectRoot: "/project" });
    view.unmount();
  });

  it("does not reload or rejoin a file deleted by the agent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "live");
    const fixture = syncFixture();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    fixture.deleteFile();
    act(() => view.result.current.overleafRealtime.suspendPaths(["section.tex"]));
    await waitFor(() => expect(view.result.current.overleafRealtime.livePaths).toEqual([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", expect.objectContaining({ live: [] }));
    expect(fixture.deps.loadFile).not.toHaveBeenCalled();
    expect(view.result.current.overleafRealtime.liveFile).toBe(false);
    view.unmount();
  });

  it("automatically recovers from a rejected stale join, including a transient sync failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "live");
    const fixture = syncFixture();
    fixture.edit("agent wrote while disconnected");
    fixture.deps.sourceRef.current = fixture.deps.savedSourceRef.current = "agent wrote while disconnected";
    fixture.deps.source = "agent wrote while disconnected";
    fixture.failOnce();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.detail).toMatch(/outside live editing/));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    expect(view.result.current.overleafRealtime.liveFile).toBe(false);
    expect(fixture.server()).toBe("old caption");
    await act(async () => { await vi.advanceTimersByTimeAsync(46_000); });
    await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    expect(fixture.server()).toBe("agent wrote while disconnected");
    expect(view.result.current.overleafRealtime.detail).toBeNull();
    view.unmount();
  });

  it.each(["live", "manual"])("reconciles disk writes in %s mode without a remote change signal", async (mode) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("lattice.overleaf.sync-mode.v1", mode);
    const fixture = syncFixture();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.status).toBe("live"));
    if (mode === "live") await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    fixture.edit("agent caption and new section");
    act(() => view.result.current.overleafRealtime.suspendPaths(["section.tex"]));
    expect(view.result.current.overleafRealtime.liveFile).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    if (mode === "manual") {
      expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "overleaf_sync")).toBe(false);
      await act(async () => { await view.result.current.runOverleafSync(); });
    } else {
      await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    }
    expect(fixture.server()).toBe("agent caption and new section");
    expect(fixture.deps.sourceRef.current).toBe(fixture.server());
    expect(fixture.deps.compile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", expect.objectContaining({ live: [] }));
    view.unmount();
  });

  it.each(["new disk edit", "typing", "conflict"])("does not resume an older sync after %s", async (change) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "live");
    const fixture = syncFixture();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    fixture.edit("first agent edit");
    fixture.hold();
    act(() => view.result.current.overleafRealtime.suspendPaths(["section.tex"]));
    await waitFor(() => expect(view.result.current.overleafRealtime.livePaths).toEqual([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    expect(fixture.deps.overleafSyncingRef.current).toBe(true);
    if (change === "new disk edit") {
      fixture.edit("second agent edit");
      act(() => view.result.current.overleafRealtime.suspendPaths(["section.tex"]));
    } else if (change === "typing") fixture.deps.sourceRef.current = "unsaved user words";
    else fixture.conflict();
    await act(async () => { fixture.finish(); });
    expect(view.result.current.overleafRealtime.liveFile).toBe(false);
    expect(fixture.server()).toBe("first agent edit");
    if (change === "typing") expect(fixture.deps.sourceRef.current).toBe("unsaved user words");
    if (change === "conflict") expect(view.result.current.conflictPath).toBe("section.tex");
    if (change === "new disk edit") {
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
      expect(fixture.server()).toBe("second agent edit");
    }
    view.unmount();
  });

  it("cancels a pending disk-edit upload when switching projects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("lattice.overleaf.sync-mode.v1", "live");
    const fixture = syncFixture();
    const view = renderHook(() => useOverleafWorkspace(fixture.deps));
    await waitFor(() => expect(view.result.current.overleafRealtime.liveFile).toBe(true));
    fixture.edit("old project agent edit");
    act(() => view.result.current.overleafRealtime.suspendPaths(["section.tex"]));
    fixture.deps.project = { ...fixture.deps.project!, root: "/next-project" };
    fixture.deps.projectRef.current = fixture.deps.project;
    fixture.deps.projectOperationGenerationRef.current += 1;
    view.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "overleaf_sync")).toBe(false);
    view.unmount();
  });
});

function thread(id: string): OverleafThread {
  return {
    id, resolved: false, resolvedBy: null, resolvedAt: null,
    messages: [{ id: `${id}-message`, content: `Body ${id}`, authorName: "Ada", authorEmail: "ada@example.com", timestamp: 1000, mine: true }],
  };
}

describe("projectOverleafEditorComments", () => {
  const paths = new Map([["doc-main", "main.tex"], ["doc-other", "chapters/other.tex"]]);
  const anchors = new Map([
    ["main", { threadId: "main", docId: "doc-main", position: 7, quote: "main quote" }],
    ["other", { threadId: "other", docId: "doc-other", position: 31, quote: "other quote" }],
    ["unknown", { threadId: "unknown", docId: "missing-doc", position: 0, quote: "unknown" }],
  ]);

  it("retains other documents when the active file changes, preferring live positions", () => {
    const comments = projectOverleafEditorComments(
      [thread("main"), thread("other"), thread("unknown"), thread("orphan")], anchors, paths,
      "doc-other", new Map([["other", { threadId: "other", position: 44, quote: "edited quote" }]]),
    );
    expect(comments.map(({ id, path, from, to, quote }) => ({ id, path, from, to, quote }))).toEqual([
      { id: "overleaf:main", path: "main.tex", from: 7, to: 17, quote: "main quote" },
      { id: "overleaf:other", path: "chapters/other.tex", from: 44, to: 56, quote: "edited quote" },
    ]);
    expect(comments[0]).toMatchObject({ body: "Body main", authorId: "ada@example.com", authorName: "Ada · Overleaf", resolved: false });
  });

  it("keeps project anchors when no live document is joined", () => {
    expect(projectOverleafEditorComments([thread("main"), thread("other")], anchors, paths, null, new Map()).map((comment) => comment.path))
      .toEqual(["main.tex", "chapters/other.tex"]);
  });

  it("uses new live anchors and does not revive deleted live anchors from REST", () => {
    const comments = projectOverleafEditorComments(
      [thread("main"), thread("new")], anchors, paths, "doc-main",
      new Map([["new", { threadId: "new", position: 3, quote: "new quote" }]]),
    );
    expect(comments.map(({ id, path, from }) => ({ id, path, from }))).toEqual([
      { id: "overleaf:new", path: "main.tex", from: 3 },
    ]);
  });
});
