import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TrellisController } from "../trellis/trellis-controller";
import type { AgentTurnReview } from "./app-synara-embed";
import { useToolDrawers } from "./use-tool-drawers";

afterEach(cleanup);

function renderTools(commentsKind: "comments" | "overleaf" = "comments") {
  const deps = {
    trellis: { revealOpenTool: vi.fn() },
    synara: { requestRuntime: vi.fn(), origin: "http://synara.test", sourceControlFrameRef: { current: null } },
    comments: { openPanel: vi.fn(), openReply: vi.fn() },
    references: { setLiteratureOpen: vi.fn() },
    refreshTodos: vi.fn(async () => undefined),
    refreshWordCount: vi.fn(async () => undefined),
  };
  const view = renderHook(() => useToolDrawers({
    ...deps, commentsKind, trellis: deps.trellis as unknown as TrellisController,
  }));
  return { view, ...deps };
}

it("opens a drawer it owns after bringing its content up to date, then reveals its panel", () => {
  const { view, trellis, refreshTodos, refreshWordCount } = renderTools();
  act(() => view.result.current.open("checklist"));
  expect(refreshTodos).toHaveBeenCalledTimes(1);
  expect(refreshWordCount).toHaveBeenCalledTimes(1);
  expect(view.result.current.isOpen).toEqual({ history: false, git: false, todos: false, checklist: true });
  expect(trellis.revealOpenTool).toHaveBeenCalledWith("checklist");

  act(() => view.result.current.open("todos"));
  expect(refreshTodos).toHaveBeenCalledTimes(2);
  expect(view.result.current.isOpen.todos).toBe(true);

  act(() => view.result.current.close("checklist"));
  expect(view.result.current.isOpen.checklist).toBe(false);
});

it("starts the agent runtime for Git and pins or unpins a turn review", () => {
  const { view, synara } = renderTools();
  const review = { threadId: "t", turnCount: 2, filePath: null } as unknown as AgentTurnReview;
  act(() => view.result.current.open("git", { turnReview: review }));
  expect(synara.requestRuntime).toHaveBeenCalled();
  expect(view.result.current.isOpen.git).toBe(true);
  expect(view.result.current.turnReview).toBe(review);

  act(() => view.result.current.showGitView("pull-requests"));
  expect(view.result.current.turnReview).toBeNull();
  expect(view.result.current.gitView).toBe("pull-requests");

  act(() => view.result.current.open("git", { gitView: "changes" }));
  expect(view.result.current.gitView).toBe("changes");
});

it("routes comments to the surface the project uses and literature to its own drawer", () => {
  const { view, trellis, comments, references } = renderTools("overleaf");
  act(() => view.result.current.open("comments"));
  expect(comments.openPanel).toHaveBeenCalledTimes(1);
  expect(trellis.revealOpenTool).toHaveBeenLastCalledWith("overleaf");

  act(() => view.result.current.open("comments", { replyTo: "c1" }));
  expect(comments.openReply).toHaveBeenCalledWith("c1");
  expect(comments.openPanel).toHaveBeenCalledTimes(1);

  act(() => view.result.current.open("literature"));
  expect(references.setLiteratureOpen).toHaveBeenCalledWith(true);
  expect(trellis.revealOpenTool).toHaveBeenLastCalledWith("literature");
  expect(view.result.current.isOpen).toEqual({ history: false, git: false, todos: false, checklist: false });
});

it("forgets the outgoing project's TODO list and turn review", () => {
  const { view } = renderTools();
  const review = { threadId: "t", turnCount: 1, filePath: null } as unknown as AgentTurnReview;
  act(() => {
    view.result.current.open("todos");
    view.result.current.open("history");
    view.result.current.open("git", { turnReview: review });
  });
  act(() => view.result.current.resetForProject());
  expect(view.result.current.isOpen).toEqual({ history: true, git: true, todos: false, checklist: false });
  expect(view.result.current.turnReview).toBeNull();
});

it("closes Git when the source control embed asks to", () => {
  const frame = { contentWindow: {} as Window };
  const { view, synara } = renderTools();
  (synara.sourceControlFrameRef as { current: unknown }).current = frame;
  act(() => view.result.current.open("git"));
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "lattice:close-source-control" }, origin: "http://elsewhere.test", source: frame.contentWindow,
    }));
  });
  expect(view.result.current.isOpen.git).toBe(true);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "lattice:close-source-control" }, origin: synara.origin, source: frame.contentWindow,
    }));
  });
  expect(view.result.current.isOpen.git).toBe(false);
});
