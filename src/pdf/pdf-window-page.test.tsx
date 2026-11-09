import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfBytesFingerprint } from "./pdf-bytes";
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
  toolbarAction: { label: string; run: () => void };
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
    const action = props.toolbarAction;
    return <div data-testid="viewer"><button type="button" onClick={action.run}>{action.label}</button></div>;
  },
}));

/** The bytes of the `build`th compiled PDF the mocked `read_compiled_pdf` reads. */
function compiled(build: number): ArrayBuffer {
  return new Uint8Array([37, 80, 68, 70, build]).buffer;
}

/** The key the owner sends for the `build`th PDF it shows: the protocol's fingerprint of its bytes. */
function key(build: number): string {
  return pdfBytesFingerprint(compiled(build));
}

function state(overrides: Partial<PdfWindowState> = {}): PdfWindowState {
  return {
    projectRoot: "/papers/transformer",
    pdfKey: key(1),
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
  host.invoke.mockImplementation(async () => compiled(++urls));
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

    await receive(state({ pdfKey: key(2) }));
    expect(host.invoke).toHaveBeenCalledTimes(2);
    expect(host.viewer?.url).toBe("blob:window-2");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:window-1");

    await receive(state({ pdfKey: key(2), syncTarget: { id: "jump-1", page: 4, x: 0, y: 0, width: 1, height: 1 } }));
    expect(host.viewer?.syncTarget?.id).toBe("jump-1");
  });

  it("keeps the PDF its owner shows when the next build is already rewriting the file", async () => {
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state());
    expect(host.viewer?.url).toBe("blob:window-1");

    // The owner now shows build 3, but the file on disk is build 2 (or half of it).
    await receive(state({ pdfKey: key(3) }));
    expect(host.invoke).toHaveBeenCalledTimes(2);
    expect(host.viewer?.url).toBe("blob:window-1");
    expect(new Uint8Array(host.viewer!.pdfBytes!)).toEqual(new Uint8Array(compiled(1)));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("shows no PDF, rather than another build's, when the first read is not the one its owner shows", async () => {
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state({ pdfKey: key(2) }));
    expect(host.viewer).toMatchObject({ url: null, pdfBytes: null });
  });

  it("reads the PDF its owner shows again once the build that was rewriting the file ends", async () => {
    // A build with a fatal error deletes the file and puts the last PDF back when it ends.
    host.invoke.mockRejectedValueOnce("Build the project first.");
    await act(async () => {
      render(<PdfWindowPage />);
    });
    await receive(state({ building: true }));
    expect(host.viewer).toMatchObject({ url: null, pdfBytes: null });

    await receive(state({ building: false }));
    expect(host.invoke).toHaveBeenCalledTimes(2);
    expect(host.viewer?.url).toBe("blob:window-1");
    // Once read, a build starting or ending reads nothing again.
    await receive(state({ building: true }));
    await receive(state({ building: false }));
    expect(host.invoke).toHaveBeenCalledTimes(2);
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
