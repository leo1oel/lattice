import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafThread } from "../app-types";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import {
  buildAgentCommentsSnapshot, readAgentCommentsSnapshot, executeAgentEditorCommentsToolRequest,
  parseAgentEditorCommentsToolRequest, SYNARA_EDITOR_COMMENTS_TOOL_REQUEST,
  type AgentEditorCommentsToolRequest,
} from "./agent-editor-comments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const local = (overrides: Partial<EditorComment> = {}): EditorComment => ({
  id: "local", path: "paper.md", from: 4, to: 9, quote: "title", prefix: "---\n", suffix: "\nbody",
  body: "Revise", authorId: "a", authorName: "Ada", resolved: false, replies: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
});
const thread = (id: string, resolved = false): OverleafThread => ({
  id, resolved, resolvedAt: null, resolvedBy: null,
  messages: [
    { id: "m1", content: "First", authorName: "Grace", authorEmail: null, timestamp: 1_000, mine: false },
    { id: "m2", content: "Reply", authorName: "Lin", authorEmail: null, timestamp: 2_000, mine: true },
  ],
});

describe("agent comments snapshot", () => {
  it("refreshes both Overleaf records and reports partial refresh failure without losing cached comments", async () => {
    const options = {
      workspaceRoot: "/p", localComments: [local()], overleafThreads: [thread("old")],
      overleafAnchors: [{ threadId: "old", docId: "d", position: 0, quote: "old" }],
      docPaths: new Map([["d", "a.tex"]]), overleaf: { status: "cached" as const },
    };
    vi.mocked(invoke).mockImplementation(async (command) => command === "overleaf_threads"
      ? [thread("new")]
      : [{ threadId: "new", docId: "d", position: 0, quote: "new" }]);
    const fresh = await readAgentCommentsSnapshot(options);
    expect(fresh.overleaf.status).toBe("fresh");
    expect(fresh.comments.map((comment) => comment.id)).toEqual(["new", "local"]);
    expect(invoke).toHaveBeenCalledWith("overleaf_threads", { projectRoot: "/p" });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "overleaf_comment_anchors") throw new Error("offline");
      return [thread("new")];
    });
    const stale = await readAgentCommentsSnapshot(options);
    expect(stale.overleaf).toMatchObject({ status: "unavailable", error: expect.stringContaining("offline") });
    expect(stale.comments.map((comment) => comment.id)).toEqual(["old", "local"]);
  });

  it("mixes sources, filters files and resolved records, and uses full-text offsets", () => {
    const result = buildAgentCommentsSnapshot({
      workspaceRoot: "/project", localComments: [local(), local({ id: "done", resolved: true })],
      overleafThreads: [thread("remote"), thread("resolved", true)],
      overleafAnchors: [{ threadId: "remote", docId: "doc", position: 6, quote: "title" }],
      docPaths: new Map([["doc", "paper.md"]]), currentSources: new Map([["paper.md", "---\ntitle\nbody"]]),
      overleaf: { status: "fresh" }, path: "paper.md", capturedAt: "now",
    });
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({ origin: "local", from: 4, anchorStatus: "exact" });
    expect(result.comments[1]).toMatchObject({ origin: "overleaf", from: 4, anchorStatus: "moved", replies: [{ body: "Reply" }] });
  });

  it("does not guess when a moved quote is repeated and reports unmapped threads", () => {
    const result = buildAgentCommentsSnapshot({
      workspaceRoot: "/p", localComments: [], overleafThreads: [thread("ambiguous"), thread("orphan")],
      overleafAnchors: [{ threadId: "ambiguous", docId: "d", position: 99, quote: "same" }],
      docPaths: new Map([["d", "a.tex"]]), currentSources: new Map([["a.tex", "same and same"]]),
      overleaf: { status: "cached" }, capturedAt: "now",
    });
    expect(result.comments[0].anchorStatus).toBe("missing");
    expect(result.omittedCount).toBe(1);
  });

  it("paginates and visibly marks bounded content", () => {
    const result = buildAgentCommentsSnapshot({
      workspaceRoot: "/p", localComments: [local({ id: "a", body: "x".repeat(9_000) }), local({ id: "b" })],
      overleafThreads: [], overleafAnchors: [], docPaths: new Map(), overleaf: { status: "not-linked" },
      offset: 0, limit: 1, capturedAt: "now",
    });
    expect(result.comments[0].body).toContain("truncated by Lattice");
    expect(result).toMatchObject({ totalCount: 2, nextOffset: 1, omittedCount: 1 });
  });
});

function request(): AgentEditorCommentsToolRequest {
  return { type: SYNARA_EDITOR_COMMENTS_TOOL_REQUEST, version: 1, id: "r", workspaceRoot: "/p", args: {}, expiresAt: Date.now() + 1_000 };
}

describe("agent comments read protocol", () => {
  it("strictly parses paths and pagination", () => {
    const input = request();
    expect(parseAgentEditorCommentsToolRequest(input)).toEqual(input);
    expect(parseAgentEditorCommentsToolRequest({ ...request(), extra: true })).toBeNull();
    expect(parseAgentEditorCommentsToolRequest({ ...request(), args: { path: "../secret", limit: 0 } })).toBeNull();
    expect(parseAgentEditorCommentsToolRequest({ ...request(), args: { path: "a\\b", offset: -1 } })).toBeNull();
  });

  it("rejects expired and cross-workspace reads before invoking the reader", async () => {
    const read = vi.fn();
    await expect(executeAgentEditorCommentsToolRequest({ ...request(), expiresAt: 0 }, () => "/p", read)).resolves.toMatchObject({ ok: false, error: { code: "editor_comments_tool_expired" } });
    await expect(executeAgentEditorCommentsToolRequest(request(), () => "/other", read)).resolves.toMatchObject({ ok: false, error: { code: "editor_comments_workspace_mismatch" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("checks the active workspace again after the asynchronous read", async () => {
    let root = "/p";
    const read = vi.fn(async () => {
      root = "/other";
      return buildAgentCommentsSnapshot({ workspaceRoot: "/p", localComments: [], overleafThreads: [], overleafAnchors: [], docPaths: new Map(), overleaf: { status: "fresh" } });
    });
    await expect(executeAgentEditorCommentsToolRequest(request(), () => root, read)).resolves.toMatchObject({ ok: false, error: { code: "editor_comments_workspace_mismatch" } });
  });
});
