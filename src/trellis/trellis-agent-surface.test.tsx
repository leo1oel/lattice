import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSnapshot } from "../app-types";
import { LATTICE_HOST_FILE_WRITES, noteHostFileWrites, setHostFileWritesSink } from "../agent/agent-host-writes";
import { projectAgentInFlight } from "../agent/project-agent-activity";
import { useSynaraHost } from "../app/use-synara-host";
import type { Theme } from "../settings/app-settings";
import TrellisAgentSurface from "./trellis-agent-surface";

const ORIGIN = "http://127.0.0.1:4173";
const runtime = vi.hoisted(() => ({
  current: {
    runtime: { state: "ready", origin: "http://127.0.0.1:4173", authToken: "token", message: null, startupMs: 1, version: "t", revision: "t" } as Record<string, unknown>,
    retry: () => undefined,
  },
}));
vi.mock("../agent/use-synara-runtime", () => ({ useSynaraRuntime: () => runtime.current }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));

const project = { root: "/paper", name: "Paper" } as unknown as ProjectSnapshot;
const otherProject = { ...project, root: "/another-paper" };
const projectRef = { current: project };
const bridge = {
  openProviderSettings: () => undefined, openProjectPath: vi.fn(), openReview: () => undefined,
  clearSelection: () => undefined, flushVisualMarkdown: () => undefined, agentCommentsOptions: () => null,
  annotationTools: () => null, projectDocumentCreator: () => null, onHistorySnapshot: () => undefined,
};

const hostRef = { current: null as ReturnType<typeof useSynaraHost> | null };
function Harness({ theme, current = project, anchor }: {
  theme: Theme; current?: ProjectSnapshot; anchor?: HTMLElement;
}) {
  const synara = useSynaraHost({
    project: current, projectRef, agentVisible: true, bridge,
    appearance: { theme, tint: null, accent: null, translucency: 0, translucent: false } as never,
  });
  useLayoutEffect(() => { hostRef.current = synara; });
  return <TrellisAgentSurface synara={synara} projectRoot={current.root} theme={theme} appLocale="en" dropActive={false} anchor={anchor} />;
}
/** The host as the harness last rendered it. */
const host = new Proxy({} as ReturnType<typeof useSynaraHost>, { get: (_target, key) => hostRef.current![key as keyof ReturnType<typeof useSynaraHost>] });

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.synara-poc-frame:not([hidden])")!;
function receive(source: Window, data: object, origin = ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { source, origin, data }));
  });
}
const embedReady = () => receive(frame().contentWindow!, { type: "synara:embed-ready" });
function activity(workspaceRoot: string, state: "running" | "waiting" | "completed") {
  return {
    type: "synara:project-agent-activity", version: 1, workspaceRoot,
    running: state === "running", waiting: state === "waiting", completedUnread: state === "completed",
  };
}
// jsdom gives a navigated frame a new window: watch each one the frame has had.
const spies = new Map<Window, { mock: { calls: unknown[][] } }>();
const posted = () => {
  const current = frame().contentWindow!;
  if (!spies.has(current)) spies.set(current, vi.spyOn(current, "postMessage"));
  return [...spies.values()].flatMap((spy) => spy.mock.calls.map(([message]) => message as Record<string, unknown>));
};
const writesPosted = () => posted()
  .map((message) => message as { type?: string; writes?: Array<{ path: string }> })
  .filter((message) => message.type === LATTICE_HOST_FILE_WRITES)
  .flatMap((message) => message.writes!.map((write) => write.path));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  projectRef.current = project;
  spies.clear();
});
afterEach(() => {
  cleanup();
  setHostFileWritesSink(null);
  vi.useRealTimers();
});

async function mountReady(theme: Theme) {
  const view = render(<Harness theme={theme} />);
  // The frame mounts on the next animation frame.
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(frame()).not.toBeNull();
  posted();
  embedReady();
  expect(host.frameReady).toBe(true);
  return view;
}

// S10 in the implicit-state audit: a reload that keeps the frame's key (here
// light/dark in its URL, which "match system" flips with no click at all) used
// to leave the panel marked ready, so a host-write report noted while the new
// document loaded went to the unloading one and was gone, and the turn's Undo
// could delete a co-author's edit (#710).
it("holds a host-write report made while the agent frame reloads until the reloaded panel is ready", async () => {
  const view = await mountReady("light");
  const firstSrc = frame().src;
  view.rerender(<Harness theme="dark" />);
  expect(frame().src).not.toBe(firstSrc);
  expect(host.frameReady).toBe(false);
  noteHostFileWrites(project.root, ["main.tex"]);
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(writesPosted()).toEqual([]);
  embedReady();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(writesPosted()).toEqual(["main.tex"]);
});

it("holds an Ask Agent prompt sent while the agent frame reloads for the reloaded panel", async () => {
  await mountReady("light");
  act(() => host.showThread("thread-2"));
  expect(host.frameReady).toBe(false);
  act(() => host.sendComposerPrompt({ type: "lattice:composer-prompt", workspaceRoot: project.root, text: "Fix it", mode: "send" } as never));
  const prompts = () => posted().filter((message) => message.text === "Fix it");
  expect(prompts()).toHaveLength(0);
  embedReady();
  expect(prompts()).toHaveLength(1);
});

it("treats the frame of a restarted agent on the same port as loading until it says it is ready", async () => {
  const view = await mountReady("light");
  const ready = runtime.current.runtime;
  runtime.current = { ...runtime.current, runtime: { ...ready, state: "starting", origin: null } };
  view.rerender(<Harness theme="light" />);
  runtime.current = { ...runtime.current, runtime: ready };
  view.rerender(<Harness theme="light" />);
  expect(frame()).not.toBeNull();
  expect(host.frameReady).toBe(false);
  embedReady();
  expect(host.frameReady).toBe(true);
});


it("keeps each project's turn, host messages and approvals with its own frame", async () => {
  const view = await mountReady("light");
  const original = frame();
  const originalWindow = original.contentWindow!;
  const originalPost = vi.mocked(originalWindow.postMessage);
  receive(originalWindow, activity(project.root, "running"));
  expect(projectAgentInFlight(project.root)).toBe(true);

  await host.retainBackgroundProject(project.root);
  expect(invoke).toHaveBeenCalledWith("retain_background_agent_project", { projectRoot: project.root });
  projectRef.current = otherProject;
  view.rerender(<Harness theme="light" current={otherProject} />);
  await act(() => vi.advanceTimersByTimeAsync(50));
  const selected = frame();
  const selectedWindow = selected.contentWindow!;
  expect(selected).not.toBe(original);
  expect(original.hidden).toBe(true);
  expect(original.contentWindow).toBe(originalWindow);
  expect(originalPost).toHaveBeenCalledWith(expect.objectContaining({
    type: "lattice:agent-panel-visibility", visible: false,
  }), ORIGIN);

  const selectedPost = vi.spyOn(selectedWindow, "postMessage");
  embedReady();
  act(() => host.sendComposerPrompt({
    type: "lattice:composer-prompt", workspaceRoot: otherProject.root, text: "Analyze this project", mode: "send",
  } as never));
  expect(selectedPost).toHaveBeenCalledWith(expect.objectContaining({ text: "Analyze this project" }), ORIGIN);
  expect(originalPost).not.toHaveBeenCalledWith(expect.objectContaining({ text: "Analyze this project" }), ORIGIN);
  receive(selectedWindow, activity(otherProject.root, "running"));
  expect(projectAgentInFlight(otherProject.root)).toBe(true);

  // Neither the wrong origin, an unrelated same-origin sender, nor the other
  // project frame can overwrite the hidden project's activity.
  receive(originalWindow, activity(project.root, "completed"), "https://other.example");
  receive(window, activity(project.root, "completed"));
  receive(selectedWindow, activity(project.root, "completed"));
  expect(projectAgentInFlight(project.root)).toBe(true);
  receive(originalWindow, activity(project.root, "waiting"));
  receive(originalWindow, { type: "synara:open-file", filePath: "/another-paper/wrong.tex" });
  expect(bridge.openProjectPath).not.toHaveBeenCalled();

  receive(originalWindow, {
    type: "synara:canvas-tool-request", version: 1, id: "parked-tool",
    action: "list", args: {}, expiresAt: Date.now() + 6_000,
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(originalPost).toHaveBeenCalledWith(expect.objectContaining({
    type: "lattice:canvas-tool-result", id: "parked-tool", ok: false,
    error: expect.objectContaining({ code: "project_not_active" }),
  }), ORIGIN);
  expect(selectedPost).not.toHaveBeenCalledWith(expect.objectContaining({ id: "parked-tool" }), ORIGIN);

  await act(() => vi.advanceTimersByTimeAsync(35_000));
  expect(original.isConnected).toBe(true);
  receive(originalWindow, activity(project.root, "completed"));
  expect(projectAgentInFlight(project.root)).toBe(false);
  expect(projectAgentInFlight(otherProject.root)).toBe(true);
  noteHostFileWrites(project.root, ["main.tex"]);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(originalPost).toHaveBeenCalledWith(expect.objectContaining({
    type: LATTICE_HOST_FILE_WRITES, workspaceRoot: project.root,
  }), ORIGIN);

  projectRef.current = project;
  view.rerender(<Harness theme="light" />);
  expect(frame()).toBe(original);
  expect(original.contentWindow).toBe(originalWindow);
  expect(host.frameReady).toBe(true);
  expect(selected.hidden).toBe(true);
  expect(invoke).toHaveBeenCalledWith("release_background_agent_project", { projectRoot: project.root });
  expect(originalPost).toHaveBeenCalledWith(expect.objectContaining({
    type: "lattice:agent-panel-visibility", visible: true,
  }), ORIGIN);
});


it("invalidates parked activity and readiness when the runtime is replaced", async () => {
  const view = await mountReady("light");
  const original = frame();
  receive(original.contentWindow!, activity(project.root, "running"));
  projectRef.current = otherProject;
  view.rerender(<Harness theme="light" current={otherProject} />);
  await act(() => vi.advanceTimersByTimeAsync(50));
  embedReady();
  receive(frame().contentWindow!, activity(otherProject.root, "waiting"));
  const ready = runtime.current.runtime;

  try {
    runtime.current = { ...runtime.current, runtime: { ...ready, authToken: "replacement-token" } };
    view.rerender(<Harness theme="light" current={otherProject} />);
    expect(original.isConnected).toBe(false);
    expect(projectAgentInFlight(project.root)).toBe(false);
    expect(projectAgentInFlight(otherProject.root)).toBe(false);
    expect(host.frameReady).toBe(false);
    embedReady();
    expect(host.frameReady).toBe(true);
  } finally {
    runtime.current = { ...runtime.current, runtime: ready };
  }
});

it("follows a recreated Trellis slot without moving the frame document", async () => {
  const workspace = document.createElement("main");
  const trellis = document.createElement("div");
  trellis.className = "trellis";
  const surface = document.createElement("div");
  surface.dataset.trellisPart = "surface";
  const anchor = document.createElement("div");
  anchor.className = "trellis-agent-host";
  const rect = vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 48, 320, 520));
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 48, 320, 520));
  vi.spyOn(trellis, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 48, 900, 520));
  trellis.append(surface);
  surface.append(anchor);
  document.body.append(workspace);
  try {
    render(<Harness theme="light" anchor={anchor} />, { container: workspace });
    workspace.prepend(trellis);
    await act(() => vi.advanceTimersByTimeAsync(50));
    embedReady();
    const original = frame();
    const originalWindow = original.contentWindow;
    const shell = original.closest<HTMLElement>(".trellis-agent-layer");
    expect(shell).toHaveAttribute("data-positioned");
    expect(shell?.style.left).toBe("200px");

    // Trellis disposes the outgoing project's slots, then creates its new own.
    act(() => { surface.removeChild(anchor); });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(shell).not.toHaveAttribute("data-positioned");
    expect(original.isConnected).toBe(true);

    act(() => {
      const replacement = document.createElement("div");
      replacement.dataset.trellisPart = "surface";
      rect.mockReturnValue(new DOMRect(500, 48, 300, 520));
      vi.spyOn(replacement, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 48, 300, 520));
      replacement.append(anchor);
      surface.replaceWith(replacement);
    });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(shell).toHaveAttribute("data-positioned");
    expect(shell?.style.left).toBe("500px");
    expect(frame()).toBe(original);
    expect(original.contentWindow).toBe(originalWindow);
  } finally {
    cleanup();
    workspace.remove();
  }
});
