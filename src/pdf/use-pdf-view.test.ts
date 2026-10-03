import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PdfFileViewState } from "../app-types";
import type { ViewerRecord } from "./pdf-slick";
import { usePdfViewState, type PdfViewerCallbacks } from "./use-pdf-view";

// The viewer itself (PDF.js) is not part of what is reported.
vi.mock("./pdf-slick", () => ({ applyPdfZoom: vi.fn() }));

describe("usePdfViewState", () => {
  it("reports where the PDF was read when its scroller has already left the document", () => {
    // A Trellis panel hands the document on before the viewer's last report:
    // the detached scroller then reads 0, which reopened the PDF at its top.
    const root = document.body.appendChild(document.createElement("div"));
    const recordRef = { current: { root } as unknown as ViewerRecord };
    const reports: PdfFileViewState[] = [];
    const callbacks = { current: { onViewState: (state) => reports.push(state) } satisfies PdfViewerCallbacks };
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    const { result } = renderHook(() => usePdfViewState(recordRef, undefined, 1, callbacks));
    act(() => result.current.activate());
    root.scrollTop = 4_358;
    act(() => {
      result.current.schedule();
      frames.splice(0).forEach((frame) => frame(0));
    });
    expect(reports.at(-1)).toMatchObject({ scrollTop: 4_358 });
    root.remove();
    Object.defineProperty(root, "scrollTop", { value: 0 });
    act(() => result.current.flush());
    expect(reports.at(-1)).toMatchObject({ scrollTop: 4_358 });
    vi.restoreAllMocks();
  });
});
