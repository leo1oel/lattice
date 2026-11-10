import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerRecord } from "./pdf-slick";
import type { PdfViewState } from "./use-pdf-view";
import { usePdfZoom } from "./use-pdf-zoom";

vi.mock("./pdf-slick", () => ({ applyPdfZoom: vi.fn(), pdfPageView: () => null }));
vi.mock("../app/window-events", () => ({ listenInThisWindow: vi.fn(async () => () => undefined) }));

function mountZoom() {
  const workspace = document.createElement("div");
  const root = document.createElement("div");
  const viewer = document.createElement("div");
  root.append(viewer);
  workspace.append(root);
  document.body.append(workspace);
  const record = { root, viewer, slick: {} } as unknown as ViewerRecord;
  const view = {
    viewRef: { current: { page: 1, scale: 1, fitMode: null } },
    fitMode: null,
    setScale: vi.fn(),
    setFitMode: vi.fn(),
  } as unknown as PdfViewState;
  renderHook(() => usePdfZoom({ current: record }, 1, view));
  return { workspace, root, viewer };
}

describe("usePdfZoom", () => {
  afterEach(() => document.body.replaceChildren());

  it("zooms the PDF on ⌘-wheel as on Ctrl-wheel, and leaves a plain wheel to scroll", () => {
    const { root, viewer } = mountZoom();
    expect(fireEvent.wheel(root, { deltaY: 10, clientX: 50, clientY: 50 })).toBe(true);
    expect(viewer.style.transform).toBe("");
    // A cancelled wheel returns false: the page does not scroll and WebKit does not zoom the window.
    expect(fireEvent.wheel(root, { metaKey: true, deltaY: -2, clientX: 50, clientY: 50 })).toBe(false);
    expect(viewer.style.transform).toBe(`scale(${Number(Math.exp(0.02).toFixed(3))})`);
    expect(fireEvent.wheel(root, { ctrlKey: true, deltaY: -2, clientX: 50, clientY: 50 })).toBe(false);
    expect(viewer.style.transform).toBe(`scale(${Number(Math.exp(0.04).toFixed(3))})`);
  });

  it.each([[-120, 0], [-3, 1], [-1, 2]])("bounds a coarse wheel event (%s, mode %s) to a fine zoom step", (deltaY, deltaMode) => {
    const { root, viewer } = mountZoom();
    Object.defineProperty(root, "clientHeight", { value: 800 });
    fireEvent.wheel(root, { ctrlKey: true, deltaY, deltaMode, clientX: 50, clientY: 50 });
    const scale = Number(viewer.style.transform.slice(6, -1));
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(1.052);
    fireEvent.wheel(root, { ctrlKey: true, deltaY: -deltaY, deltaMode });
    expect(Number(viewer.style.transform.slice(6, -1))).toBeCloseTo(1, 2);
  });

  it("keeps a Chromium Ctrl-wheel pinch event at its full scale", () => {
    const { root, viewer } = mountZoom();
    // Chromium reports a pinch as one Ctrl-wheel of -100 * ln(scale) pixels.
    fireEvent.wheel(root, { ctrlKey: true, deltaY: -40, clientX: 50, clientY: 50 });
    expect(viewer.style.transform).toBe(`scale(${Number(Math.exp(0.4).toFixed(3))})`);
  });

  it("keeps a pinch over the PDF from also zooming the workspace around it", () => {
    const { workspace, root, viewer } = mountZoom();
    const workspaceZoom = vi.fn();
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) workspace.addEventListener(type, workspaceZoom);
    const gesture = (type: string, scale: number) =>
      root.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 50, clientY: 50 }));
    expect(gesture("gesturestart", 1)).toBe(false);
    expect(gesture("gesturechange", 1.5)).toBe(false);
    expect(gesture("gestureend", 1.5)).toBe(false);
    expect(viewer.style.transform).toBe("scale(1.5)");
    expect(workspaceZoom).not.toHaveBeenCalled();
  });
});
