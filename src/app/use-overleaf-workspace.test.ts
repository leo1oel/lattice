import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafThread } from "../app-types";
import { useOverleafRealtime } from "../overleaf/use-overleaf-realtime";
import { applyOverleafRemoteText, projectOverleafEditorComments } from "./use-overleaf-workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => vi.mocked(invoke).mockReset());

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
    expect(invoke).toHaveBeenCalledWith("overleaf_rt_leave_doc", { projectRoot: "/project", docId: "section" });
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
