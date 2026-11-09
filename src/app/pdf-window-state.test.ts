import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrellisController } from "../trellis/trellis-controller";

const runtime = vi.hoisted(() => ({ browserHosted: false }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => runtime.browserHosted }));

type State = typeof import("./pdf-window-state");

/** A fresh module per test: it caches each project's choice for the session. */
async function load(): Promise<State> {
  vi.resetModules();
  return import("./pdf-window-state");
}

function workspace({ root = "/papers/a", focus = false, pdfPanel = true } = {}) {
  const ws = { view: vi.fn((kind: string) => (kind === "pdf" && pdfPanel ? { panelId: "pdf" } : undefined)), close: vi.fn(async () => true) };
  const trellis = {
    ws,
    app: { get: () => ({ projectRoot: root }) },
    ui: { get: () => ({ focus }) },
    showPanel: vi.fn(),
    setFocusPdf: vi.fn(),
  };
  return { trellis, controller: trellis as unknown as TrellisController };
}

beforeEach(() => {
  localStorage.clear();
  runtime.browserHosted = false;
});

describe("the PDF's separate window", () => {
  it("is the panel by default, and remembered per project once chosen", async () => {
    let state = await load();
    const { trellis, controller } = workspace();
    expect(state.pdfWindowOpen("/papers/a")).toBe(false);

    state.detachPdf(controller, "/papers/a");
    expect(state.pdfWindowOpen("/papers/a")).toBe(true);
    expect(state.pdfWindowOpen("/papers/b")).toBe(false);
    // The panel closes, so the documents get its room.
    expect(trellis.ws.close).toHaveBeenCalledWith("pdf", { force: true });
    expect(state.takePdfWindowFocus("/papers/a")).toBe(true);
    expect(state.takePdfWindowFocus("/papers/a")).toBe(false);

    // Reopening the project (a new launch) restores it, and opens the window behind the editor.
    state = await load();
    expect(state.pdfWindowOpen("/papers/a")).toBe(true);
    expect(state.takePdfWindowFocus("/papers/a")).toBe(false);

    state.dockPdf(controller, "/papers/a");
    expect(state.pdfWindowOpen("/papers/a")).toBe(false);
    expect(trellis.showPanel).toHaveBeenCalledWith("pdf", { focus: false });
    state = await load();
    expect(state.pdfWindowOpen("/papers/a")).toBe(false);
  });

  it("notifies who shows it, once per change", async () => {
    const state = await load();
    const { controller } = workspace();
    const { result } = renderHook(() => state.usePdfWindowOpen("/papers/a"));
    expect(result.current).toBe(false);
    act(() => state.detachPdf(controller, "/papers/a"));
    expect(result.current).toBe(true);
    act(() => state.dockPdf(controller, "/papers/a"));
    expect(result.current).toBe(false);
  });

  it("leaves focus mode's PDF to focus mode's own switch", async () => {
    const state = await load();
    const { trellis, controller } = workspace({ focus: true });
    state.detachPdf(controller, "/papers/a");
    expect(trellis.setFocusPdf).toHaveBeenCalledWith(false);
    expect(trellis.ws.close).not.toHaveBeenCalled();
  });

  it("keeps builds and jumps from bringing the panel back while the PDF is apart", async () => {
    const state = await load();
    const { trellis, controller } = workspace();
    state.showProjectPdf(controller);
    expect(trellis.showPanel).toHaveBeenCalledTimes(1);

    state.detachPdf(controller, "/papers/a");
    expect(state.pdfInWindow(controller)).toBe(true);
    state.showProjectPdf(controller);
    expect(trellis.showPanel).toHaveBeenCalledTimes(1);

    // In focus mode the PDF stays as the writer set it, window or not.
    const focused = workspace({ root: "/papers/b", focus: true });
    state.showProjectPdf(focused.controller);
    expect(focused.trellis.showPanel).not.toHaveBeenCalled();
  });

  it("remembers where the window was left, and ignores a frame that is not one", async () => {
    const state = await load();
    expect(state.pdfWindowFrame("/papers/a")).toBeNull();
    state.rememberPdfWindowFrame("/papers/a", { x: 1600, y: 40, width: 900, height: 1100 });
    state.detachPdf(workspace().controller, "/papers/a");
    // Choosing to open or close the window keeps the frame.
    expect(state.pdfWindowFrame("/papers/a")).toEqual({ x: 1600, y: 40, width: 900, height: 1100 });
    expect(state.pdfWindowFrame("/papers/b")).toBeNull();

    localStorage.setItem("lattice.pdf-window.v1:/papers/c", JSON.stringify({ open: true, frame: { x: "left" } }));
    expect(state.pdfWindowFrame("/papers/c")).toBeNull();
    localStorage.setItem("lattice.pdf-window.v1:/papers/d", "{not json");
    expect(state.pdfWindowOpen("/papers/d")).toBe(false);
  });

  it("is not offered in a browser tab, where there are no windows to give it", async () => {
    localStorage.setItem("lattice.pdf-window.v1:/papers/a", JSON.stringify({ open: true }));
    runtime.browserHosted = true;
    const state = await load();
    expect(state.pdfWindowsAvailable()).toBe(false);
    expect(state.pdfWindowOpen("/papers/a")).toBe(false);
    const { trellis, controller } = workspace();
    state.detachPdf(controller, "/papers/b");
    expect(state.pdfWindowOpen("/papers/b")).toBe(false);
    expect(trellis.ws.close).not.toHaveBeenCalled();
  });
});

describe("compiledPdfName", () => {
  it("names the PDF after the root document it is compiled from", async () => {
    const state = await load();
    expect(state.compiledPdfName("main.tex")).toBe("main.pdf");
    expect(state.compiledPdfName("paper/thesis.v2.tex")).toBe("thesis.v2.pdf");
    expect(state.compiledPdfName(null)).toBe("paper.pdf");
  });
});
