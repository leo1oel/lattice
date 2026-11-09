import type { ComponentProps } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfWindowState } from "../pdf/pdf-window-protocol";
import { pdfWindowFrame, rememberPdfWindowFrame } from "../app/pdf-window-state";
import { ProjectPdfWindow } from "./project-pdf-window";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  emitTo: vi.fn(async (_label: string, _event: string, _payload: unknown) => {}),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  setFocus: vi.fn(async () => {}),
  showError: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: tauri.emitTo,
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = tauri.listeners.get(event) ?? new Set();
    handlers.add(handler);
    tauri.listeners.set(event, handlers);
    return () => handlers.delete(handler);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main", setFocus: tauri.setFocus }) }));
vi.mock("../app/notify", () => ({ showError: tauri.showError }));

const ROOT = "/papers/transformer";

/** Something the backend or the PDF window sent this window. */
async function hear(event: string, payload: unknown) {
  await act(async () => {
    for (const handler of tauri.listeners.get(event) ?? []) handler({ payload });
  });
}

function sentStates(): PdfWindowState[] {
  return tauri.emitTo.mock.calls.filter(([, event]) => event === "pdf-window:state").map(([, , state]) => state as PdfWindowState);
}

function props(overrides: { pdfUrl?: string | null; target?: { id: string; page: number } | null } = {}) {
  const view: ComponentProps<typeof ProjectPdfWindow> = {
    projectRoot: ROOT,
    previewPath: "main.tex",
    control: { open: true, title: "main.pdf — Transformer", onOpen: vi.fn(), onDock: vi.fn() },
    pdf: {
      pdfUrl: overrides.pdfUrl === undefined ? "blob:build-1" : overrides.pdfUrl,
      pdfSyncTarget: overrides.target ? { ...overrides.target, x: 72, y: 500, width: 200, height: 12 } : null,
      canForwardSync: true,
      locatingPdf: false,
      building: false,
      onForwardSync: vi.fn(),
      onPdfSource: vi.fn(),
      onPdfPageCount: vi.fn(),
      onPdfPageChange: vi.fn(),
      onBuildProject: vi.fn(),
    },
    citations: {
      citations: [
        { key: "vaswani2017", title: "Attention", authors: "Vaswani", year: "2017", venue: "NeurIPS" },
        { key: "unknown2020", title: "Unknown", authors: "", year: "2020", venue: "" },
      ],
      canOpenCitation: (key: string) => key === "vaswani2017",
      onOpenCitation: vi.fn(),
    },
    outline: { nodes: [], activeId: null, open: false, onOpenChange: vi.fn(), onNavigate: vi.fn() },
    selection: { onPdfTextSelect: vi.fn(), onContextSurfaceActivate: vi.fn() },
    viewState: {
      getFileViewState: () => ({ pdf: { page: 3, scale: 1.2, fitMode: null, scrollTop: 640, scrollLeft: 0 } }),
      onFileViewState: vi.fn(),
    },
  };
  return view;
}

beforeEach(() => {
  localStorage.clear();
  tauri.listeners.clear();
  tauri.emitTo.mockClear();
  tauri.setFocus.mockClear();
  tauri.showError.mockClear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (command) => (command === "open_pdf_window" ? "pdf-1" : undefined));
});

afterEach(cleanup);

describe("the PDF panel's separate window", () => {
  it("opens where it was left for the project and sends the state the panel would render from", async () => {
    rememberPdfWindowFrame(ROOT, { x: 1600, y: 40, width: 900, height: 1100 });
    const view = props();
    await act(async () => {
      render(<ProjectPdfWindow {...view} />);
    });
    expect(tauri.invoke).toHaveBeenCalledWith("open_pdf_window", {
      title: "main.pdf — Transformer", frame: { x: 1600, y: 40, width: 900, height: 1100 }, focus: false,
    });
    expect(sentStates()).toHaveLength(1);
    expect(tauri.emitTo.mock.calls[0][0]).toBe("pdf-1");
    expect(sentStates()[0]).toMatchObject({
      projectRoot: ROOT,
      pdfKey: "blob:build-1",
      canForwardSync: true,
      openableCitations: ["vaswani2017"],
      outline: { available: true },
      viewState: { page: 3, scrollTop: 640 },
    });
  });

  it("follows each build and each jump into the PDF, and answers a window that starts listening", async () => {
    const view = props();
    let rerender!: ReturnType<typeof render>["rerender"];
    await act(async () => {
      ({ rerender } = render(<ProjectPdfWindow {...view} />));
    });
    // A rebuild's new PDF, then a forward SyncTeX jump from the editor.
    await act(async () => rerender(<ProjectPdfWindow {...props({ pdfUrl: "blob:build-2" })} />));
    await act(async () => rerender(<ProjectPdfWindow {...props({ pdfUrl: "blob:build-2", target: { id: "jump-1", page: 5 } })} />));
    expect(sentStates().map((state) => [state.pdfKey, state.syncTarget?.id ?? null])).toEqual([
      ["blob:build-1", null], ["blob:build-2", null], ["blob:build-2", "jump-1"],
    ]);

    await hear("pdf-window:action", { window: "pdf-1", kind: "ready" });
    expect(sentStates()).toHaveLength(4);
    // Another workspace window's PDF window is not this one's.
    await hear("pdf-window:action", { window: "pdf-7", kind: "ready" });
    expect(sentStates()).toHaveLength(4);
  });

  it("carries out the reader's actions with the panel's callbacks, bringing the editor forward for a jump to the source", async () => {
    const view = props();
    await act(async () => {
      render(<ProjectPdfWindow {...view} />);
    });
    await hear("pdf-window:action", { window: "pdf-1", kind: "source", page: 2, x: 100, y: 300, word: null });
    expect(view.pdf.onPdfSource).toHaveBeenCalledWith(2, 100, 300, null);
    expect(tauri.setFocus).toHaveBeenCalledOnce();

    await hear("pdf-window:action", { window: "pdf-1", kind: "forward-sync" });
    await hear("pdf-window:action", { window: "pdf-1", kind: "outline", path: "intro.tex", line: 4 });
    await hear("pdf-window:action", { window: "pdf-1", kind: "citation", key: "unknown2020" });
    await hear("pdf-window:action", { window: "pdf-1", kind: "citation", key: "vaswani2017" });
    await hear("pdf-window:action", { window: "pdf-1", kind: "view-state", state: { page: 6, scale: 1, fitMode: "width", scrollTop: 10, scrollLeft: 0 } });
    expect(view.pdf.onForwardSync).toHaveBeenCalledOnce();
    expect(view.outline.onNavigate).toHaveBeenCalledWith("intro.tex", 4);
    expect(view.citations.onOpenCitation).toHaveBeenCalledOnce();
    expect(view.citations.onOpenCitation).toHaveBeenCalledWith("vaswani2017", undefined);
    expect(view.viewState.onFileViewState).toHaveBeenCalledWith("main.tex", { pdf: expect.objectContaining({ page: 6 }) });

    await hear("pdf-window:action", { window: "pdf-1", kind: "dock" });
    expect(view.control.onDock).toHaveBeenCalledOnce();
  });

  it("docks when the writer closes the window, and remembers where it was moved", async () => {
    const view = props();
    await act(async () => {
      render(<ProjectPdfWindow {...view} />);
    });
    await hear("pdf-window-frame", { label: "pdf-1", frame: { x: 10, y: 20, width: 700, height: 800 } });
    await hear("pdf-window-frame", { label: "pdf-9", frame: { x: 0, y: 0, width: 1, height: 1 } });
    expect(pdfWindowFrame(ROOT)).toEqual({ x: 10, y: 20, width: 700, height: 800 });

    await hear("pdf-window-closed", "pdf-9");
    expect(view.control.onDock).not.toHaveBeenCalled();
    await hear("pdf-window-closed", "pdf-1");
    expect(view.control.onDock).toHaveBeenCalledOnce();
  });

  it("closes the window when the PDF docks or the project closes, even one still opening", async () => {
    const { unmount } = await act(async () => render(<ProjectPdfWindow {...props()} />));
    unmount();
    expect(tauri.invoke).toHaveBeenLastCalledWith("close_pdf_window", { label: "pdf-1" });

    let opened!: (label: string) => void;
    tauri.invoke.mockImplementation((command) => (command === "open_pdf_window"
      ? new Promise((resolve) => { opened = resolve; })
      : Promise.resolve(undefined)));
    const early = render(<ProjectPdfWindow {...props()} />);
    early.unmount();
    await act(async () => opened("pdf-2"));
    expect(tauri.invoke).toHaveBeenLastCalledWith("close_pdf_window", { label: "pdf-2" });
    expect(sentStates()).toHaveLength(1);
  });

  it("goes back to the panel when the window cannot open", async () => {
    tauri.invoke.mockRejectedValue("Could not open the PDF in a new window: no display");
    const view = props();
    await act(async () => {
      render(<ProjectPdfWindow {...view} />);
    });
    expect(tauri.showError).toHaveBeenCalledWith("Could not open the PDF in a new window: no display");
    expect(view.control.onDock).toHaveBeenCalledOnce();
  });
});
