import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectSnapshot } from "../app-types";
import { LATTICE_HOST_FILE_WRITES, noteHostFileWrites, setHostFileWritesSink } from "../agent/agent-host-writes";
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

const project = { root: "/paper", name: "Paper" } as unknown as ProjectSnapshot;
const projectRef = { current: project };
const bridge = {
  openProviderSettings: () => undefined, openProjectPath: () => undefined, openReview: () => undefined,
  clearSelection: () => undefined, flushVisualMarkdown: () => undefined, agentCommentsOptions: () => null,
  annotationTools: () => null, projectDocumentCreator: () => null, onHistorySnapshot: () => undefined,
  onMinimumWidth: () => undefined,
};

const hostRef = { current: null as ReturnType<typeof useSynaraHost> | null };
function Harness({ theme }: { theme: Theme }) {
  const synara = useSynaraHost({
    project, projectRef, agentVisible: true, bridge,
    appearance: { theme, tint: null, accent: null, translucency: 0, translucent: false } as never,
  });
  useLayoutEffect(() => { hostRef.current = synara; });
  return <TrellisAgentSurface synara={synara} projectRoot={project.root} theme={theme} appLocale="en" dropActive={false} />;
}
/** The host as the harness last rendered it. */
const host = new Proxy({} as ReturnType<typeof useSynaraHost>, { get: (_target, key) => hostRef.current![key as keyof ReturnType<typeof useSynaraHost>] });

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.synara-poc-frame")!;
const embedReady = () => act(() => {
  window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, origin: ORIGIN, data: { type: "synara:embed-ready" } }));
});
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
