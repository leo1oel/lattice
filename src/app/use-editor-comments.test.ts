import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { useEditorComments } from "./use-editor-comments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const comment = (id: string): EditorComment => ({
  id, path: "main.tex", from: 0, to: 5, quote: "alpha", prefix: "", suffix: "",
  body: `Note ${id}`, authorId: "me", authorName: "Me", resolved: false, replies: [],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});

/** The comment list over one project, not linked to Overleaf. */
function renderComments() {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const project = { root: "/project" } as unknown as ProjectSnapshot;
  const projectRootRef = { current: "/project" as string | null };
  const overleaf = {
    overleafLink: null,
    overleafComments: { threads: [], anchors: new Map() },
    overleafCommentsRef: { current: { threads: [] } },
    overleafDocPaths: new Map(),
    overleafRealtime: { docId: null, liveFile: null },
    overleafEditorComments: [],
    setOverleafCollabOpen: vi.fn(),
    setOverleafCollabTab: vi.fn(),
  } as unknown as Parameters<typeof useEditorComments>[0]["overleaf"];
  const view = renderHook(() => useEditorComments({
    project, projectRootRef, overleaf, author: { id: "me", name: "Me" },
    openSources: () => new Map(), agentOptionsRef: { current: null },
  }));
  return { view, projectRootRef };
}

const saved = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_editor_comments")
  .map(([, args]) => (args as { comments: EditorComment[] }).comments.map((item) => item.id));

it("deletes a comment at once and its undo puts it back where it was, keeping later changes", async () => {
  const { view } = renderComments();
  await act(() => view.result.current.persist([comment("a"), comment("b"), comment("c")]));

  let undo: (() => void) | null = null;
  act(() => { undo = view.result.current.remove("b"); });
  expect(view.result.current.comments.map((item) => item.id)).toEqual(["a", "c"]);

  // Something else changes before the undo; the undo must not lose it.
  await act(() => view.result.current.persist([...view.result.current.comments, comment("d")]));
  act(() => undo?.());
  expect(view.result.current.comments.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  expect(saved().at(-1)).toEqual(["a", "b", "c", "d"]);
});

it("does nothing on undo once another project is open, or for a comment that is not there", async () => {
  const { view, projectRootRef } = renderComments();
  await act(() => view.result.current.persist([comment("a")]));
  expect(view.result.current.remove("missing")).toBeNull();

  let undo: (() => void) | null = null;
  act(() => { undo = view.result.current.remove("a"); });
  const saves = saved().length;
  projectRootRef.current = "/other";
  act(() => undo?.());
  expect(saved()).toHaveLength(saves);
  expect(view.result.current.comments).toEqual([]);
});
