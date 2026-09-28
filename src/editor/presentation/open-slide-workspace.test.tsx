import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenSlideWorkspace } from "./open-slide-workspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const tauriEvents = vi.hoisted(() => ({
  projectChanged: null as null | ((event: { payload: { root: string } }) => void),
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
});
