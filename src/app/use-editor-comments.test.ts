import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { notifyInfo } from "../telemetry/app-notify";
import { useEditorComments } from "./use-editor-comments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(notifyInfo).mockReset();
});

const comment = (id: string): EditorComment => ({
  id, path: "main.tex", from: 0, to: 5, quote: "alpha", prefix: "", suffix: "",
  body: `Note ${id}`, authorId: "me", authorName: "Me", resolved: false, replies: [],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
});

/** The comment list over one project, not linked to Overleaf, holding `initial` once loaded. */
async function renderComments(initial: EditorComment[]) {
  vi.mocked(invoke).mockImplementation(async (command) => (command === "list_editor_comments" ? initial : undefined));
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
  const activeFileRef = { current: "" };
  const openProjectFile = vi.fn(async (path: string) => {
    activeFileRef.current = path;
  });
  const view = renderHook(() => useEditorComments({
    project, projectRootRef, activeFileRef, openProjectFile, overleaf, author: { id: "me", name: "Me" },
    openSources: () => new Map(), agentOptionsRef: { current: null },
  }));
  await act(() => view.result.current.load());
  return { view, projectRootRef, activeFileRef, openProjectFile };
}

const saved = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "save_editor_comments")
  .map(([, args]) => (args as { comments: EditorComment[] }).comments.map((item) => item.id));
const ids = (comments: EditorComment[]) => comments.map((item) => item.id);

/** The Undo on the toast the last delete raised. */
function lastUndo() {
  const options = vi.mocked(notifyInfo).mock.calls.at(-1)?.[2];
  return () => options?.primaryAction?.onClick();
}

it("deletes a comment at once and its undo puts it back where it was, keeping later changes", async () => {
  const { view } = await renderComments([comment("a"), comment("b"), comment("c")]);
  act(() => view.result.current.deleteComment("b"));
  expect(ids(view.result.current.comments)).toEqual(["a", "c"]);
  const undo = lastUndo();

  // Something else changes before the undo; the undo must not lose it.
  act(() => view.result.current.create(comment("d")));
  act(() => undo());
  expect(ids(view.result.current.comments)).toEqual(["a", "b", "c", "d"]);
  expect(saved().at(-1)).toEqual(["a", "b", "c", "d"]);
});

it("does nothing on undo once another project is open, or for a comment that is not there", async () => {
  const { view, projectRootRef } = await renderComments([comment("a")]);
  act(() => view.result.current.deleteComment("missing"));
  expect(notifyInfo).not.toHaveBeenCalled();

  act(() => view.result.current.deleteComment("a"));
  const undo = lastUndo();
  const saves = saved().length;
  projectRootRef.current = "/other";
  act(() => undo());
  expect(saved()).toHaveLength(saves);
  expect(view.result.current.comments).toEqual([]);
});

it("opens a comment's file and asks the editor to focus it, unless a newer comment was opened first", async () => {
  const { view, openProjectFile } = await renderComments([comment("a"), { ...comment("b"), path: "intro.tex" }]);
  await act(async () => view.result.current.openComment(view.result.current.comments[0]));
  // The focus places the editor, so the file's remembered position must not land after it.
  expect(openProjectFile).toHaveBeenCalledWith("main.tex", { restoreView: false });
  expect(view.result.current.activeId).toBe("a");
  const request = view.result.current.focusRequest;
  expect(request?.id).toBe("a");
  act(() => view.result.current.focusHandled(request!.nonce));
  expect(view.result.current.focusRequest).toBeNull();

  let finishFirst: () => void = () => undefined;
  openProjectFile.mockImplementationOnce(() => new Promise((resolve) => {
    finishFirst = resolve;
  }));
  act(() => view.result.current.openComment(view.result.current.comments[0]));
  await act(async () => view.result.current.openComment(view.result.current.comments[1]));
  expect(view.result.current.focusRequest?.id).toBe("b");
  await act(async () => finishFirst());
  expect(view.result.current.focusRequest?.id).toBe("b");
  expect(view.result.current.activeId).toBe("b");
});
