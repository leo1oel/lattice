import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafThread, ProjectSnapshot } from "../app-types";
import { useOverleafRealtime } from "../overleaf/use-overleaf-realtime";
import { applyOverleafRemoteText, projectOverleafEditorComments, useOverleafWorkspace, type OverleafWorkspaceDeps } from "./use-overleaf-workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  localStorage.clear();
});

/** The realtime channel's answers for a project whose only document is section.tex. */
function realtimeReply(command: string, serverText: string) {
  if (command === "overleaf_rt_connect") return {
    publicId: "me", docs: [{ id: "section", path: "section.tex" }], entities: [],
    permission: "readAndWrite", trackChanges: false, userId: "me",
  };
  if (command === "overleaf_rt_join_doc") return {
    text: serverText, version: 4, comments: [], changes: [], caughtUp: [], resumed: false,
  };
}

function remoteFixture() {
  const deps: Parameters<typeof applyOverleafRemoteText>[0] = {
    projectRef: { current: { root: "/project" } as ProjectSnapshot },
    projectOperationGenerationRef: { current: 1 },
    activeFileRef: { current: "section.tex" },
    sourceRef: { current: "old caption" },
    savedSourceRef: { current: "old caption" },
    // The open documents' compare-and-swap: only a buffer still holding `expect` takes the text.
    accept: vi.fn((path: string, content: string, expect: { text: string; saved: string }) => {
      if (deps.activeFileRef.current !== path || deps.sourceRef.current !== expect.text
        || deps.savedSourceRef.current !== expect.saved) return false;
      deps.sourceRef.current = deps.savedSourceRef.current = content;
      return true;
    }),
    compile: vi.fn(async () => {}),
  };
  const context = { projectRoot: "/project", path: "section.tex", baseContent: "old caption", isCurrent: () => true };
  return { deps, context };
}

describe("safe Overleaf remote text delivery", () => {
  it("keeps an agent draft when opening the file against an older live snapshot", async () => {
    const { deps } = remoteFixture();
    deps.sourceRef.current = deps.savedSourceRef.current = "agent caption and new section";
    const notice = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => realtimeReply(command, "old caption"));
    const view = renderHook(() => useOverleafRealtime({
      enabled: true, documents: true, projectRoot: "/project", activeFile: "section.tex",
      onNotice: notice,
      onRemoteText: (text, context) => applyOverleafRemoteText(deps, text, context),
    }));
    await waitFor(() => expect(notice).toHaveBeenCalled());
    expect(view.result.current.liveFile).toBe(false);
    expect(view.result.current.livePaths).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", {
      projectRoot: "/project", docId: "section", receipt: expect.any(String), checkpoint: null,
    });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "write_project_file")).toBe(false);
    expect(deps.sourceRef.current).toBe("agent caption and new section");
  });

  it("does not replace the editor when disk rejects a stale live write", async () => {
    const { deps, context } = remoteFixture();
    vi.mocked(invoke).mockRejectedValue(new Error("Agent changed the disk"));
    await expect(applyOverleafRemoteText(deps, "remote caption", context)).rejects.toThrow("Agent changed");
    expect(invoke).toHaveBeenCalledWith("write_project_file", {
      path: "section.tex", projectRoot: "/project", content: "remote caption", expectedContent: "old caption",
    });
    expect(deps.sourceRef.current).toBe("old caption");
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.compile).not.toHaveBeenCalled();
  });

  it("updates both editor baselines and rebuilds only after a successful guarded write", async () => {
    const { deps, context } = remoteFixture();
    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(await applyOverleafRemoteText(deps, "remote caption", context)).toBe(true);
    expect(deps.accept).toHaveBeenCalledWith("section.tex", "remote caption", { text: "old caption", saved: "old caption" });
    expect(deps.sourceRef.current).toBe("remote caption");
    expect(deps.savedSourceRef.current).toBe("remote caption");
    expect(deps.compile).toHaveBeenCalledOnce();
  });

  it.each(["typing", "navigation", "project generation"])("does not apply a late response after %s", async (change) => {
    const { deps, context } = remoteFixture();
    let resolve!: () => void;
    vi.mocked(invoke).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const pending = applyOverleafRemoteText(deps, "remote caption", context);
    if (change === "typing") deps.sourceRef.current = "my unfinished edit";
    if (change === "navigation") deps.activeFileRef.current = "other.tex";
    if (change === "project generation") deps.projectOperationGenerationRef.current += 1;
    await act(async () => { resolve(); });
    expect(await pending).toBe(false);
    expect(deps.sourceRef.current).toBe(change === "typing" ? "my unfinished edit" : "old caption");
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
  const editedDuringSync: string[] = [];
  const project = {
    root: "/project", files: [],
    manifest: { schemaVersion: 1, projectId: "paper", name: "Paper", rootDocuments: [], primaryBibliography: "references.bib", trusted: false },
  };
  const deps: OverleafWorkspaceDeps = {
    ...remote, project, activeFile: "section.tex", source: "old caption",
    activePaper: null, activeAsset: null,
    editorPosition: null, editorPositionRef: { current: null }, build: null,
    saveGeneration: 0, savedPathsRef: { current: new Set() },
    wholeFileEditingPaths: [], wholeFileDraftPaths: [], save: vi.fn(async () => true),
    loadFile: vi.fn(async (_path, options) => {
      if (options?.canCommit?.() === false) return false;
      remote.sourceRef.current = remote.savedSourceRef.current = deps.source = disk;
      return true;
    }),
    refreshProject: vi.fn(async () => project), openProjectFile: vi.fn(),
    overleafSyncingRef: { current: false }, overleafSyncSettledRef: { current: null },
    resolveOverleafSyncRef: { current: null },
  };
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "overleaf_link") return { projectId: "ol-paper", projectName: "Paper", host: "https://www.overleaf.com", paused: false };
    if (command === "overleaf_status") return { connected: true, host: "https://www.overleaf.com" };
    if (command === "overleaf_probe") return { versionKnown: true, changed: false, localChanged: false, remoteVersion: 1 };
    if (command === "read_project_file") return disk;
    if (command.startsWith("overleaf_rt_")) return realtimeReply(command, server) ?? [];
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
        editedDuringSync: editedDuringSync.splice(0),
      };
    }
    return [];
  });
  return {
    deps,
    edit: (text: string) => { disk = text; },
    hold: () => { holdSync = true; },
    conflict: (alreadyResolved = false) => {
      conflict = true;
      if (!alreadyResolved) disk = "<<<<<<< ours\nlocal\n=======\nremote\n>>>>>>> theirs\n";
    },
    failOnce: () => { failSync = true; },
    deleteFile: () => { deleted = true; },
    /** The next sync reports `path` changed on disk while it ran. */
    editDuringSync: (path: string) => { editedDuringSync.push(path); },
    finish: () => { holdSync = false; finishSync?.(); },
    server: () => server,
  };
}

/** Mount the workspace over `syncFixture` in `mode`, on fake timers the tests advance. */
function mountWorkspace(mode: "live" | "manual", prepare?: (fixture: ReturnType<typeof syncFixture>) => void) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.setItem("lattice.overleaf.sync-mode.v1", mode);
  const fixture = syncFixture();
  prepare?.(fixture);
  const view = renderHook(() => useOverleafWorkspace(fixture.deps));
  const realtime = () => view.result.current.overleafRealtime;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const suspend = () => act(() => realtime().suspendPaths(["section.tex"]));
  const synced = () => vi.mocked(invoke).mock.calls.some(([command]) => command === "overleaf_sync");
  return { fixture, view, realtime, advance, suspend, synced };
}

describe("external edit Overleaf handoff", () => {
  it.each([true, false])("checks current file markers before opening a conflict (already resolved: %s)", async (resolved) => {
    const { fixture, view, realtime } = mountWorkspace("manual");
    await waitFor(() => expect(realtime().status).toBe("live"));
    fixture.conflict(resolved);
    await act(async () => { await view.result.current.runOverleafSync(); });
    expect(view.result.current.conflictPath).toBe(resolved ? null : "section.tex");
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "section.tex", projectRoot: "/project" });
  });

  it("does not reload or rejoin a file deleted by the agent", async () => {
    const { fixture, realtime, advance, suspend } = mountWorkspace("live");
    await waitFor(() => expect(realtime().liveFile).toBe(true));
    fixture.deleteFile();
    suspend();
    await waitFor(() => expect(realtime().livePaths).toEqual([]));
    await advance(2_600);
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", expect.objectContaining({ live: [] }));
    expect(fixture.deps.loadFile).not.toHaveBeenCalled();
    expect(realtime().liveFile).toBe(false);
  });

  it("automatically recovers from a rejected stale join, including a transient sync failure", async () => {
    const { fixture, realtime, advance } = mountWorkspace("live", (fixture) => {
      fixture.edit("agent wrote while disconnected");
      fixture.deps.sourceRef.current = fixture.deps.savedSourceRef.current = "agent wrote while disconnected";
      fixture.deps.source = "agent wrote while disconnected";
      fixture.failOnce();
    });
    await waitFor(() => expect(realtime().detail).toMatch(/outside live editing/));
    await advance(2_600);
    expect(realtime().liveFile).toBe(false);
    expect(fixture.server()).toBe("old caption");
    await advance(46_000);
    await waitFor(() => expect(realtime().liveFile).toBe(true));
    expect(fixture.server()).toBe("agent wrote while disconnected");
    expect(realtime().detail).toBeNull();
  });

  it.each(["live", "manual"] as const)("reconciles disk writes in %s mode without a remote change signal", async (mode) => {
    const { fixture, view, realtime, advance, suspend, synced } = mountWorkspace(mode);
    await waitFor(() => expect(realtime().status).toBe("live"));
    if (mode === "live") await waitFor(() => expect(realtime().liveFile).toBe(true));
    fixture.edit("agent caption and new section");
    suspend();
    expect(realtime().liveFile).toBe(false);
    await advance(2_600);
    if (mode === "manual") {
      expect(synced()).toBe(false);
      await act(async () => { await view.result.current.runOverleafSync(); });
    } else {
      await waitFor(() => expect(realtime().liveFile).toBe(true));
    }
    expect(fixture.server()).toBe("agent caption and new section");
    expect(fixture.deps.sourceRef.current).toBe(fixture.server());
    // Taken into the open editor where it is: a saved view put back over it would predate the edit.
    expect(fixture.deps.loadFile).toHaveBeenCalledWith("section.tex", expect.objectContaining({ restoreView: false }));
    expect(fixture.deps.compile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("overleaf_sync", expect.objectContaining({ live: [] }));
  });

  it.each(["new disk edit", "typing", "conflict"])("does not resume an older sync after %s", async (change) => {
    const { fixture, view, realtime, advance, suspend } = mountWorkspace("live");
    await waitFor(() => expect(realtime().liveFile).toBe(true));
    fixture.edit("first agent edit");
    fixture.hold();
    suspend();
    await waitFor(() => expect(realtime().livePaths).toEqual([]));
    await advance(2_600);
    expect(fixture.deps.overleafSyncingRef.current).toBe(true);
    if (change === "new disk edit") {
      fixture.edit("second agent edit");
      suspend();
    } else if (change === "typing") fixture.deps.sourceRef.current = "unsaved user words";
    else fixture.conflict();
    await act(async () => { fixture.finish(); });
    expect(realtime().liveFile).toBe(false);
    expect(fixture.server()).toBe("first agent edit");
    if (change === "typing") expect(fixture.deps.sourceRef.current).toBe("unsaved user words");
    if (change === "conflict") expect(view.result.current.conflictPath).toBe("section.tex");
    if (change === "new disk edit") {
      await advance(31_000);
      await waitFor(() => expect(realtime().liveFile).toBe(true));
      expect(fixture.server()).toBe("second agent edit");
    }
  });

  it("syncs again a file the last sync found edited on disk while it ran", async () => {
    const { fixture, view, realtime, advance } = mountWorkspace("live");
    await waitFor(() => expect(realtime().liveFile).toBe(true));
    const syncs = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "overleaf_sync").length;
    await advance(31_000);
    const before = syncs();
    fixture.editDuringSync("chapters/intro.tex");
    await act(async () => { await view.result.current.runOverleafSync(); });
    // Nothing else signals that edit: the sync's own report has to bring
    // the next one, and only the one.
    await advance(31_000);
    await waitFor(() => expect(syncs()).toBe(before + 2));
    await advance(31_000);
    expect(syncs()).toBe(before + 2);
  });

  it("cancels a pending disk-edit upload when switching projects", async () => {
    const { fixture, view, realtime, advance, suspend, synced } = mountWorkspace("live");
    await waitFor(() => expect(realtime().liveFile).toBe(true));
    fixture.edit("old project agent edit");
    suspend();
    fixture.deps.project = { ...fixture.deps.project!, root: "/next-project" };
    fixture.deps.projectRef.current = fixture.deps.project;
    fixture.deps.projectOperationGenerationRef.current += 1;
    view.rerender();
    await advance(31_000);
    expect(synced()).toBe(false);
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
    const live = new Map([["new", { threadId: "new", position: 3, quote: "new quote" }]]);
    const comments = projectOverleafEditorComments([thread("main"), thread("new")], anchors, paths, "doc-main", live);
    expect(comments.map(({ id, path, from }) => ({ id, path, from }))).toEqual([{ id: "overleaf:new", path: "main.tex", from: 3 }]);
  });
});
