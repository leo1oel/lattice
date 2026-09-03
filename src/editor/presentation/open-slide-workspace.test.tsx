import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLocale, Theme } from "../../settings/app-settings";
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

const runtime = {
  state: "ready" as const,
  origin: "http://127.0.0.1:43123",
  sessionUrl: "http://127.0.0.1:43123/__lattice/bootstrap?token=session",
  controlToken: "control",
  version: "1.19.1",
  projectRoot: "/tmp/project",
  leases: 1,
  leaseId: "11111111-1111-1111-1111-111111111111",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function workspace(
  onContext?: React.ComponentProps<typeof OpenSlideWorkspace>["onContext"],
  theme: Theme = "light",
  locale: AppLocale = "en",
  initialViewState?: React.ComponentProps<typeof OpenSlideWorkspace>["initialViewState"],
  onViewState?: React.ComponentProps<typeof OpenSlideWorkspace>["onViewState"],
) {
  return (
    <OpenSlideWorkspace
      projectRoot="/tmp/project"
      path="slides/research-update/index.tsx"
      source="export default [];\n"
      editable
      locale={locale}
      theme={theme}
      onMutation={vi.fn(async () => [])}
      onContext={onContext}
      initialViewState={initialViewState}
      onViewState={onViewState}
    />
  );
}

describe("OpenSlideWorkspace", () => {
  beforeEach(() => {
    tauriEvents.projectChanged = null;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "presentation_ensure_ready") return runtime;
      return undefined;
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/__lattice/events")) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leases the managed runtime, authenticates the iframe, and releases the exact lease", async () => {
    const { unmount } = render(workspace());

    const frame = await screen.findByTitle("Open Slide editor for research-update");
    expect(frame).toHaveAttribute(
      "src",
      `${runtime.sessionUrl}&locale=en&theme=light&next=%2Fs%2Fresearch-update`,
    );
    expect(frame).toHaveAttribute("allow", "clipboard-write; fullscreen");
    expect(frame).toHaveAttribute("allowfullscreen");
    expect(frame.closest('[data-tour="open-slide-workspace"]')).not.toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      `${runtime.origin}/__lattice/access`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ leaseId: runtime.leaseId, writable: true }),
      }),
    ));

    unmount();
    expect(invoke).toHaveBeenCalledWith("presentation_release", {
      projectRoot: "/tmp/project",
      leaseId: runtime.leaseId,
    });
  });

  it("passes the Lattice language and resolved theme into the embedded editor", async () => {
    render(workspace(undefined, "dark", "zh-CN"));

    await waitFor(() => expect(document.querySelector("iframe")).toHaveAttribute(
      "src",
      `${runtime.sessionUrl}&locale=zh-CN&theme=dark&next=%2Fs%2Fresearch-update`,
    ));
  });

  it("releases a lease that finishes starting after the workspace closes", async () => {
    const startup = deferred<typeof runtime>();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "presentation_ensure_ready") return startup.promise;
      return undefined;
    });
    const { unmount } = render(workspace());
    unmount();
    startup.resolve(runtime);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("presentation_release", {
      projectRoot: "/tmp/project",
      leaseId: runtime.leaseId,
    }));
  });

  it("refreshes native files from project events instead of frequent polling", async () => {
    const setInterval = vi.spyOn(window, "setInterval");
    render(workspace());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "presentation_refresh_native_workspace",
      { projectRoot: "/tmp/project" },
    ));
    await waitFor(() => expect(tauriEvents.projectChanged).not.toBeNull());
    expect(setInterval).not.toHaveBeenCalledWith(expect.any(Function), 30_000);
    const refreshesBeforeEvent = vi.mocked(invoke).mock.calls.filter(
      ([command]) => command === "presentation_refresh_native_workspace",
    ).length;

    tauriEvents.projectChanged?.({ payload: { root: "/tmp/project" } });

    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(
      ([command]) => command === "presentation_refresh_native_workspace",
    ).length).toBe(refreshesBeforeEvent + 1));
  });

  it("restores and remembers the live Open Slide page with its inspector selection", async () => {
    const encoder = new TextEncoder();
    let eventRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith("/__lattice/events")) {
        return new Response(null, { status: 204 });
      }
      eventRequests += 1;
      if (eventRequests > 1) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            "id: 3\ndata: {\"id\":3,\"type\":\"context\",\"context\":{\"slideId\":\"research-update\",\"pageIndex\":1,\"pageNumber\":2,\"totalPages\":4,\"slideTitle\":\"Research update\",\"view\":\"slides\",\"pagePath\":\"slides/research-update/index.tsx\",\"selection\":{\"line\":42,\"column\":6,\"tagName\":\"h1\",\"text\":\"Q2 Roadmap\"},\"updatedAt\":\"2026-08-30T12:00:00.000Z\"}}\n\n",
          ));
          controller.close();
        },
      }), { status: 200 });
    }));
    const onContext = vi.fn();
    const onViewState = vi.fn();

    render(workspace(onContext, "light", "en", { page: 3 }, onViewState));

    expect(await screen.findByTitle("Open Slide editor for research-update")).toHaveAttribute(
      "src",
      `${runtime.sessionUrl}&locale=en&theme=light&next=%2Fs%2Fresearch-update%3Fp%3D3`,
    );

    await waitFor(() => expect(onContext).toHaveBeenCalledWith(expect.objectContaining({
      pagePath: "slides/research-update/index.tsx",
      pageNumber: 2,
      selection: expect.objectContaining({ line: 42, tagName: "h1" }),
    })));
    expect(onViewState).toHaveBeenCalledWith({ page: 2 });
  });
});
