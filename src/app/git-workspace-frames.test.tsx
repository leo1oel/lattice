import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_SYNARA_RUNTIME, type AgentGitWorkspaceView, type SynaraRuntimeInfo } from "../agent/synara-runtime";
import type { AgentTurnReview, SynaraFrameContext } from "./app-synara-embed";
import { GIT_FRAME_READY_GRACE_MS, GIT_FRAME_STALL_MS, GitWorkspaceFrames } from "./git-workspace-frames";

const ORIGIN = "http://127.0.0.1:4100";
const FRAME: SynaraFrameContext = { origin: ORIGIN, authToken: "token", projectRoot: "/tmp/paper", theme: "light", locale: "en" };
const READY: SynaraRuntimeInfo = { ...EMPTY_SYNARA_RUNTIME, state: "ready", origin: ORIGIN };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderFrames({ frame = FRAME as SynaraFrameContext | null, view = "changes" as AgentGitWorkspaceView, turnReview = null as AgentTurnReview | null, runtime = READY } = {}) {
  const frameRef = createRef<HTMLIFrameElement>();
  const props = { frame, view, turnReview, runtime, onRetryRuntime: () => {}, frameRef };
  const view_ = render(<GitWorkspaceFrames {...props} />);
  return {
    frameRef,
    rerender: (next: Partial<typeof props>) => view_.rerender(<GitWorkspaceFrames {...props} {...next} />),
  };
}

const frameFor = (title: string) => document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);

function postReady(frame: HTMLIFrameElement | null, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "synara:embed-ready" }, origin, source: frame?.contentWindow ?? null }));
  });
}

/** The shell, while it covers the selected frame; once that has rendered it only fades out. */
const shell = () => document.querySelector(".git-workspace-shell:not([data-ready])");

it("shows the Git skeleton and a polite status from the first frame, while the runtime is still starting", async () => {
  renderFrames({ frame: null, runtime: EMPTY_SYNARA_RUNTIME });
  expect(shell()).not.toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
  expect(await screen.findByRole("status")).toHaveTextContent("Loading changes…");
  // The controls' own icons are drawn at once, before any Git data.
  expect(document.querySelectorAll(".git-workspace-skeleton svg").length).toBeGreaterThanOrEqual(2);
});

it("keeps the shell over the frame until that frame says it has rendered", async () => {
  renderFrames();
  const changes = frameFor("Changes")!;
  expect(changes.src).toContain("/source-control");
  expect(shell()).not.toBeNull();
  // Not from another origin, nor from a window that is not this frame.
  postReady(changes, "http://evil.example");
  postReady(null);
  expect(shell()).not.toBeNull();
  postReady(changes);
  expect(shell()).toBeNull();
});

it("drops the shell after the frame's load event for a Synara that never posts embed-ready", () => {
  vi.useFakeTimers();
  renderFrames();
  fireEvent.load(frameFor("Changes")!);
  act(() => vi.advanceTimersByTime(GIT_FRAME_READY_GRACE_MS - 1));
  expect(screen.getByRole("status")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(shell()).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
});

it("keeps a visited view's frame loaded under the selected one, so switching back is instant", async () => {
  const { frameRef, rerender } = renderFrames();
  const changes = frameFor("Changes")!;
  postReady(changes);
  expect(shell()).toBeNull();
  expect(frameRef.current).toBe(changes);

  rerender({ view: "pull-requests" });
  const pullRequests = frameFor("Pull requests")!;
  expect(pullRequests.src).toContain("/pull-requests/");
  // The click shows the new view's loading state at once, over its own frame.
  expect(shell()).not.toBeNull();
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(pullRequests).toHaveAttribute("data-active");
  expect(changes).not.toHaveAttribute("data-active");
  expect(changes).toHaveAttribute("aria-hidden", "true");
  expect(frameRef.current).toBe(pullRequests);
  postReady(pullRequests);
  expect(shell()).toBeNull();

  rerender({ view: "changes" });
  // The same document, not a reload, and no shell: it rendered already.
  expect(frameFor("Changes")).toBe(changes);
  expect(changes).toHaveAttribute("data-active");
  expect(shell()).toBeNull();
  expect(frameRef.current).toBe(changes);
});

it("covers a frame sent somewhere new until it renders there", async () => {
  const { rerender } = renderFrames();
  const changes = frameFor("Changes")!;
  postReady(changes);
  expect(shell()).toBeNull();
  rerender({ frame: { ...FRAME, theme: "dark" } });
  expect(frameFor("Changes")).toBe(changes);
  expect(shell()).not.toBeNull();
  postReady(changes);
  expect(shell()).toBeNull();
});

it("drops the pinned agent turn's frame with its tab", () => {
  const review = { threadId: "thread-1", turnId: "turn-9", filePath: null };
  const { rerender } = renderFrames({ turnReview: review });
  expect(frameFor("Agent turn review")!.src).toContain("turnId=turn-9");
  expect(screen.getByRole("status")).toBeInTheDocument();
  rerender({ turnReview: null });
  expect(frameFor("Agent turn review")).toBeNull();
  expect(frameFor("Changes")).not.toBeNull();
});

it("offers Retry when a frame has not rendered in time, and retrying loads it again", () => {
  vi.useFakeTimers();
  renderFrames();
  const first = frameFor("Changes")!;
  act(() => vi.advanceTimersByTime(GIT_FRAME_STALL_MS));
  expect(screen.getByRole("alert")).toHaveTextContent("Git workspace didn’t load");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const second = frameFor("Changes")!;
  expect(second).not.toBe(first);
  expect(screen.queryByRole("alert")).toBeNull();
  postReady(second);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("shows the runtime's failure, with its Retry, when the Synara runtime has stopped", () => {
  const onRetryRuntime = vi.fn();
  const frameRef = createRef<HTMLIFrameElement>();
  render(
    <GitWorkspaceFrames
      frame={null}
      view="changes"
      turnReview={null}
      runtime={{ ...EMPTY_SYNARA_RUNTIME, state: "stopped", message: "spawn failed" }}
      onRetryRuntime={onRetryRuntime}
      frameRef={frameRef}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Agent unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetryRuntime).toHaveBeenCalled();
});
