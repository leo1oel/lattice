import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetOpenSlideEventCursorsForTests,
  type OpenSlideEvent,
  type OpenSlideMutation,
} from "./open-slide-bridge";
import { OpenSlideWorkspace } from "./open-slide-workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const tauriEvents = vi.hoisted(() => ({
  projectChanged: null as null | ((event: { payload: { root: string } }) => void),
}));
const browserRuntime = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    detached: false,
    listeners,
    detach() {
      this.detached = true;
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../platform/browser-runtime", () => ({
  browserRuntimeDetached: () => browserRuntime.detached,
  subscribeBrowserRuntimeDetached: (listener: () => void) => {
    browserRuntime.listeners.add(listener);
    return () => browserRuntime.listeners.delete(listener);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: typeof tauriEvents.projectChanged) => {
    tauriEvents.projectChanged = handler;
    return () => { tauriEvents.projectChanged = null; };
  }),
}));

/** The `presentation_ensure_ready` fields the workspace reads. */
const runtime = {
  origin: "http://127.0.0.1:43123",
  sessionUrl: "http://127.0.0.1:43123/__lattice/bootstrap?token=session",
  controlToken: "control",
  leaseId: "11111111-1111-1111-1111-111111111111",
};
const RELEASE = ["presentation_release", { projectRoot: "/tmp/project", leaseId: runtime.leaseId }] as const;
const REFRESH = "presentation_refresh_native_workspace";
const FRAME_TITLE = "Open Slide editor for research-update";

type OpenSlideBroadcast = Omit<OpenSlideMutation, "id"> | {
  type: "context";
  context: Extract<OpenSlideEvent, { type: "context" }>["context"];
};

// Mirrors the runtime's event queue: every event is numbered and kept in
// history, a stream that names a Last-Event-ID (0 included) gets everything
// after it, and every stream then learns the current sequence.
function fakeOpenSlideRuntime() {
  const encoder = new TextEncoder();
  const history: { id: number; frame: string }[] = [];
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const eventHeaders: (string | undefined)[] = [];
  let sequence = 0;
  let gate: Promise<void> | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/__lattice/events")) return new Response(null, { status: 204 });
    const header = (init?.headers as Record<string, string> | undefined)?.["last-event-id"];
    eventHeaders.push(header);
    await gate;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    streams.add(stream);
    init?.signal?.addEventListener("abort", () => {
      streams.delete(stream);
      stream.error(new DOMException("The operation was aborted.", "AbortError"));
    });
    if (header !== undefined) {
      for (const event of history) {
        if (event.id > Number(header)) stream.enqueue(encoder.encode(event.frame));
      }
    }
    stream.enqueue(encoder.encode(`data: ${JSON.stringify({ id: sequence, type: "ready" })}\n\n`));
    return new Response(body, { status: 200 });
  });
  return {
    fetchMock,
    eventHeaders,
    eventRequests: () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/__lattice/events")),
    broadcast(event: OpenSlideBroadcast) {
      sequence += 1;
      const frame = `id: ${sequence}\ndata: ${JSON.stringify({ id: sequence, ...event })}\n\n`;
      history.push({ id: sequence, frame });
      for (const stream of streams) stream.enqueue(encoder.encode(frame));
      return sequence;
    },
    // Ends every open stream and holds reconnects until the returned resume
    // callback runs, so a test can broadcast into the gap deterministically.
    disconnect() {
      let resume!: () => void;
      gate = new Promise<void>((next) => { resume = next; });
      for (const stream of streams) stream.close();
      streams.clear();
      return () => {
        gate = null;
        resume();
      };
    },
  };
}

const deckEdit: Omit<OpenSlideMutation, "id"> = {
  path: "slides/research-update/index.tsx",
  kind: "write",
  text: "export default ['edited'];\n",
  previousText: "export default [];\n",
};

function workspace(props: Partial<ComponentProps<typeof OpenSlideWorkspace>> = {}) {
  return (
    <OpenSlideWorkspace
      projectRoot="/tmp/project"
      path="slides/research-update/index.tsx"
      source={"export default [];\n"}
      editable
      locale="en"
      theme="light"
      onMutation={vi.fn(async () => [])}
      {...props}
    />
  );
}

/** An SSE frame carrying a live presentation context for the test deck. */
function contextFrame(id: number, context: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify({
    id,
    type: "context",
    context: {
      slideId: "research-update",
      pageIndex: 0,
      pageNumber: 1,
      totalPages: 4,
      slideTitle: "Research update",
      view: "slides",
      pagePath: "slides/research-update/index.tsx",
      selection: null,
      updatedAt: "2026-08-30T12:00:00.000Z",
      ...context,
    },
  })}\n\n`);
}

/** Route the event stream through `events`; every control POST succeeds. */
function stubFetch(events: () => ReadableStream<Uint8Array> = () => new ReadableStream({ start() {} })) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
    String(input).endsWith("/__lattice/events")
      ? new Response(events(), { status: 200 })
      : new Response(null, { status: 204 })
  )));
}

const fetchCalls = (endpoint: string) =>
  vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith(`/__lattice/${endpoint}`));
const refreshCount = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === REFRESH).length;

describe("OpenSlideWorkspace", () => {
  beforeEach(() => {
    tauriEvents.projectChanged = null;
    browserRuntime.detached = false;
    browserRuntime.listeners.clear();
    __resetOpenSlideEventCursorsForTests();
    vi.mocked(invoke).mockImplementation(async (command) => (command === "presentation_ensure_ready" ? runtime : undefined));
    stubFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["en", "light"],
    ["zh-CN", "dark"],
  ] as const)("leases the runtime, authenticates the iframe with locale %s and theme %s, and releases the exact lease", async (locale, theme) => {
    const { unmount } = render(workspace({ locale, theme }));

    const frame = await screen.findByTitle(FRAME_TITLE);
    expect(frame).toHaveAttribute("src", `${runtime.sessionUrl}&locale=${locale}&theme=${theme}&next=%2Fs%2Fresearch-update`);
    expect(frame).toHaveAttribute("allow", "clipboard-write; fullscreen");
    expect(frame).toHaveAttribute("allowfullscreen");
    expect(frame.closest('[data-tour="open-slide-workspace"]')).not.toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      `${runtime.origin}/__lattice/access`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ leaseId: runtime.leaseId, writable: true }) }),
    ));

    unmount();
    expect(invoke).toHaveBeenCalledWith(...RELEASE);
  });

  it("releases a lease that finishes starting after the workspace closes", async () => {
    let finishStartup!: (value: typeof runtime) => void;
    vi.mocked(invoke).mockImplementation(async (command) => (
      command === "presentation_ensure_ready" ? new Promise((resolve) => { finishStartup = resolve; }) : undefined
    ));
    const { unmount } = render(workspace());
    unmount();
    finishStartup(runtime);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(...RELEASE));
  });

  it("refreshes native files from project events instead of frequent polling", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    render(workspace());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(REFRESH, { projectRoot: "/tmp/project" }));
    await waitFor(() => expect(tauriEvents.projectChanged).not.toBeNull());
    expect(setInterval).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
    const refreshesBeforeEvent = refreshCount();

    tauriEvents.projectChanged?.({ payload: { root: "/tmp/project" } });
    await waitFor(() => expect(refreshCount()).toBe(refreshesBeforeEvent + 1));
  });

  it("defers native refreshes while the inspector has unsaved edits", async () => {
    let events!: ReadableStreamDefaultController<Uint8Array>;
    stubFetch(() => new ReadableStream({ start(controller) { events = controller; } }));
    const { rerender } = render(workspace());
    await waitFor(() => expect(tauriEvents.projectChanged).not.toBeNull());
    await waitFor(() => expect(refreshCount()).toBeGreaterThan(0));

    events.enqueue(contextFrame(3, { pendingEdits: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const syncsBeforeEvent = fetchCalls("sync").length;
    const refreshesBeforeEvent = refreshCount();

    rerender(workspace({ source: "export default ['remote'];\n" }));
    tauriEvents.projectChanged?.({ payload: { root: "/tmp/project" } });
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(fetchCalls("sync")).toHaveLength(syncsBeforeEvent);
    expect(refreshCount()).toBe(refreshesBeforeEvent);

    events.enqueue(contextFrame(4, { pendingEdits: false, updatedAt: "2026-08-30T12:00:01.000Z" }));
    await waitFor(() => expect(refreshCount()).toBe(refreshesBeforeEvent + 1));
    await waitFor(() => expect(fetchCalls("sync").length).toBe(syncsBeforeEvent + 1));
  });

  it("restores and remembers the live Open Slide page with its inspector selection", async () => {
    let eventRequests = 0;
    stubFetch(() => new ReadableStream({
      start(controller) {
        eventRequests += 1;
        if (eventRequests > 1) return;
        controller.enqueue(contextFrame(3, {
          pageIndex: 3,
          pageNumber: 4,
          selection: { line: 42, column: 6, tagName: "h1", text: "Q2 Roadmap" },
        }));
        controller.close();
      },
    }));
    const onContext = vi.fn();
    const onViewState = vi.fn();

    render(workspace({ onContext, initialViewState: { page: 3 }, onViewState }));

    expect(await screen.findByTitle(FRAME_TITLE))
      .toHaveAttribute("src", `${runtime.sessionUrl}&locale=en&theme=light&next=%2Fs%2Fresearch-update%3Fp%3D3`);
    await waitFor(() => expect(onContext).toHaveBeenCalledWith(expect.objectContaining({
      pagePath: "slides/research-update/index.tsx",
      pageNumber: 4,
      selection: expect.objectContaining({ line: 42, tagName: "h1" }),
    })));
    expect(onViewState).toHaveBeenCalledWith({ page: 4 });
    await waitFor(() => expect(eventRequests).toBeGreaterThan(1));
    const eventCalls = fetchCalls("events");
    expect(eventCalls[0]?.[1]?.headers).not.toHaveProperty("last-event-id");
    expect(eventCalls[1]?.[1]?.headers).toMatchObject({ "last-event-id": "3" });
  });

  describe("event stream continuity", () => {
    it("keeps one event stream and one source sync while App rebuilds its callbacks", async () => {
      const runtimeEvents = fakeOpenSlideRuntime();
      vi.stubGlobal("fetch", runtimeEvents.fetchMock);
      const { rerender } = render(workspace({ onError: vi.fn(), onContext: vi.fn() }));
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(1));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith(
        REFRESH, { projectRoot: "/tmp/project" }));
      const syncs = () => runtimeEvents.fetchMock.mock.calls.filter(([input]) => (
        String(input).endsWith("/__lattice/sync")
      )).length;
      await waitFor(() => expect(syncs()).toBe(2));

      // Every project refresh hands the workspace new callback identities.
      const latestMutation = vi.fn(async () => []);
      for (let refresh = 0; refresh < 5; refresh += 1) {
        rerender(workspace({
          onMutation: refresh === 4 ? latestMutation : vi.fn(async () => []),
          onError: vi.fn(),
          onContext: vi.fn(),
        }));
        await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
      }
      // Callback churn alone must not push the project source back into
      // Open Slide: that is what overwrote saves the host had not yet seen.
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      expect(syncs()).toBe(2);

      const id = runtimeEvents.broadcast(deckEdit);
      await waitFor(() => expect(latestMutation).toHaveBeenCalledWith({ id, ...deckEdit }));
      expect(runtimeEvents.eventRequests()).toHaveLength(1);
      expect(runtimeEvents.eventRequests()[0]?.[1]?.signal?.aborted).toBe(false);
      // The native refresh queued after the applied mutation syncs once.
      await waitFor(() => expect(syncs()).toBe(3));
    });

    it("applies a mutation broadcast while the stream reconnects, even from cursor zero", async () => {
      const runtimeEvents = fakeOpenSlideRuntime();
      vi.stubGlobal("fetch", runtimeEvents.fetchMock);
      const onMutation = vi.fn(async () => []);
      render(workspace({ onMutation }));
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(1));
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      const resume = runtimeEvents.disconnect();
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(2));
      const id = runtimeEvents.broadcast(deckEdit);
      resume();

      await waitFor(() => expect(onMutation).toHaveBeenCalledWith({ id, ...deckEdit }));
      expect(onMutation).toHaveBeenCalledTimes(1);
      expect(runtimeEvents.eventHeaders).toEqual([undefined, "0"]);
    });

    it("resumes a remounted workspace after what this page already applied", async () => {
      const runtimeEvents = fakeOpenSlideRuntime();
      vi.stubGlobal("fetch", runtimeEvents.fetchMock);
      // History from an earlier page must not be replayed into this one.
      runtimeEvents.broadcast({ ...deckEdit, text: "export default ['earlier page'];\n" });
      const first = vi.fn(async () => []);
      const { unmount } = render(workspace({ onMutation: first }));
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(1));
      const applied = runtimeEvents.broadcast(deckEdit);
      await waitFor(() => expect(first).toHaveBeenCalledWith({ id: applied, ...deckEdit }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      unmount();

      const missed = { ...deckEdit, text: "export default ['while remounting'];\n" };
      const missedId = runtimeEvents.broadcast(missed);
      const second = vi.fn(async () => []);
      render(workspace({ onMutation: second }));

      await waitFor(() => expect(second).toHaveBeenCalledWith({ id: missedId, ...missed }));
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledTimes(1);
      expect(runtimeEvents.eventHeaders).toEqual([undefined, String(applied)]);
    });

    it("replays a mutation broadcast while its deck was hidden", async () => {
      const runtimeEvents = fakeOpenSlideRuntime();
      vi.stubGlobal("fetch", runtimeEvents.fetchMock);
      const onMutation = vi.fn(async () => []);
      const { rerender } = render(workspace({ onMutation }));
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(1));
      await new Promise((resolve) => window.setTimeout(resolve, 0));

      rerender(workspace({ onMutation, active: false }));
      const id = runtimeEvents.broadcast(deckEdit);
      rerender(workspace({ onMutation, active: true }));

      await waitFor(() => expect(onMutation).toHaveBeenCalledWith({ id, ...deckEdit }));
      expect(onMutation).toHaveBeenCalledTimes(1);
    });

    it("stops accepting and applying saves once another tab displaces this page", async () => {
      const runtimeEvents = fakeOpenSlideRuntime();
      vi.stubGlobal("fetch", runtimeEvents.fetchMock);
      const onMutation = vi.fn(async () => []);
      render(workspace({ onMutation }));
      expect(await screen.findByTitle(FRAME_TITLE)).toBeInTheDocument();
      await waitFor(() => expect(runtimeEvents.eventRequests()).toHaveLength(1));

      act(() => browserRuntime.detach());

      expect(screen.queryByTitle(FRAME_TITLE)).toBeNull();
      expect(runtimeEvents.eventRequests()[0]?.[1]?.signal?.aborted).toBe(true);
      await waitFor(() => expect(fetch).toHaveBeenCalledWith(
        `${runtime.origin}/__lattice/access`,
        expect.objectContaining({
          body: JSON.stringify({ leaseId: runtime.leaseId, remove: true }),
        }),
      ));
      runtimeEvents.broadcast(deckEdit);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      expect(onMutation).not.toHaveBeenCalled();
      expect(runtimeEvents.eventRequests()).toHaveLength(1);
    });
  });
});
