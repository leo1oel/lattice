import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfWindowState } from "./pdf-window-protocol";
import { PdfWindowPage } from "./pdf-window-page";

type ViewerProps = {
  url: string | null;
  pdfBytes: ArrayBuffer | null;
  syncTarget: { id: string } | null;
  initialViewState?: { page: number };
  canOpenCitation: (key: string) => boolean;
  onSource: (page: number, x: number, y: number, word: null) => void;
  onForwardSync: () => void;
  onOpenCitation: (key: string) => void;
  onViewState: (state: object) => void;
  onBuild: () => void;
  toolbarEnd: React.ReactNode;
};

const host = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  emit: vi.fn(async (_event: string, _payload: unknown) => {}),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  viewer: null as ViewerProps | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: host.emit,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void, options?: { target?: string }) => {
    // The window hears only what is addressed to it.
    expect(options?.target).toBe("pdf-1");
    host.listeners.set(event, handler);
    return () => host.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "pdf-1" }) }));
vi.mock("../settings/use-appearance", () => ({ useAppearance: () => undefined }));
vi.mock("./pdf-viewer", () => ({
  PdfPreview: (props: ViewerProps) => {
    host.viewer = props;
    return <div data-testid="viewer">{props.toolbarEnd}</div>;
  },
}));

function state(overrides: Partial<PdfWindowState> = {}): PdfWindowState {
  return {
    projectRoot: "/papers/transformer",
    pdfKey: "blob:build-1",
    syncTarget: null,
    canForwardSync: true,
    locatingPdf: false,
    building: false,
    citations: [],
    openableCitations: ["vaswani2017"],
    outline: { nodes: [], activeId: null, available: true },
    viewState: { page: 3, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 },
    ...overrides,
  };
}

async function receive(next: PdfWindowState) {
  await act(async () => host.listeners.get("pdf-window:state")?.({ payload: next }));
}

function actions() {
  return host.emit.mock.calls.filter(([event]) => event === "pdf-window:action").map(([, action]) => action);
}

let urls = 0;
beforeEach(() => {
  urls = 0;
  host.viewer = null;
  host.listeners.clear();
  host.emit.mockClear();
  host.invoke.mockReset();
  host.invoke.mockImplementation(async () => new Uint8Array([37, 80, 68, 70, ++urls]).buffer);
  URL.createObjectURL = vi.fn(() => `blob:window-${urls}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the PDF window's page", () => {
  it("asks its owner for the state once it is listening, and reads the compiled PDF the state names", async () => {
    await act(async () => {
      render(<PdfWindowPage />);
    });
    expect(actions()).toEqual([{ kind: "ready", window: "pdf-1" }]);
    expect(screen.queryByTestId("viewer")).toBeNull();

    await receive(state());
    expect(host.invoke).toHaveBeenCalledWith("read_compiled_pdf", { projectRoot: "/papers/transformer" });
    expect(host.viewer).toMatchObject({ url: "blob:window-1", initialViewState: { page: 3 } });
    expect(new Uint8Array(host.viewer!.pdfBytes!)).toEqual(new Uint8Array([37, 80, 68, 70, 1]));
  });

  it("shows each build, keeping the last PDF until the next is read, and each jump into it", async () => {
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state());
    // A state that changes something else reads nothing again.
    await receive(state({ building: true }));
    expect(host.invoke).toHaveBeenCalledTimes(1);

    await receive(state({ pdfKey: "blob:build-2" }));
    expect(host.invoke).toHaveBeenCalledTimes(2);
    expect(host.viewer?.url).toBe("blob:window-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:window-1");

    await receive(state({ pdfKey: "blob:build-2", syncTarget: { id: "jump-1", page: 4, x: 0, y: 0, width: 1, height: 1 } }));
    expect(host.viewer?.syncTarget?.id).toBe("jump-1");
  });

  it("sends what the reader does to its owner, signed with its label", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state());
    host.emit.mockClear();
    const viewer = host.viewer!;
    act(() => {
      viewer.onSource(2, 100, 300, null);
      viewer.onForwardSync();
      viewer.onBuild();
    });
    expect(viewer.canOpenCitation("vaswani2017")).toBe(true);
    expect(viewer.canOpenCitation("unknown2020")).toBe(false);
    act(() => viewer.onOpenCitation("vaswani2017"));
    fireEvent.click(screen.getByRole("button", { name: "Return to workspace" }));
    expect(actions()).toEqual([
      { kind: "source", page: 2, x: 100, y: 300, word: null, window: "pdf-1" },
      { kind: "forward-sync", window: "pdf-1" },
      { kind: "build", window: "pdf-1" },
      { kind: "citation", key: "vaswani2017", window: "pdf-1" },
      { kind: "dock", window: "pdf-1" },
    ]);

    // The place, which changes with each frame of a scroll, goes once it settles.
    host.emit.mockClear();
    act(() => {
      viewer.onViewState({ page: 4, scale: 1, fitMode: null, scrollTop: 100, scrollLeft: 0 });
      viewer.onViewState({ page: 5, scale: 1, fitMode: null, scrollTop: 900, scrollLeft: 0 });
    });
    expect(actions()).toEqual([]);
    act(() => vi.advanceTimersByTime(300));
    expect(actions()).toEqual([{ kind: "view-state", state: expect.objectContaining({ page: 5 }), window: "pdf-1" }]);
  });

  it("shows no PDF, not a spinner, when the one named cannot be read", async () => {
    host.invoke.mockRejectedValue("Build the project first.");
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state());
    expect(host.viewer).toMatchObject({ url: null, pdfBytes: null });
  });
});
